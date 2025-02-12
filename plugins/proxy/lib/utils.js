'use strict';

// Modules
const _ = require('lodash');
const hasher = require('object-hash');
const url = require('url');

const merge = require('../../../utils/merge');

/*
 * Helper to get URLs for app info and scanning purposes
 */
const getInfoUrls = (url, ports, hasCerts = false) => {
  // Start with the default
  const urls = [`http://${url.host}${ports.http === '80' ? '' : `:${ports.http}`}${url.pathname}`];
  // Add https if we can
  if (hasCerts) {
    urls.push(`https://${url.host}${ports.https === '443' ? '' : `:${ports.https}`}${url.pathname}`);
  }
  // Return
  return urls;
};

/*
 * Reduces urls to first open port
 */
exports.getFirstOpenPort = (scanner, urls = []) => scanner(urls, {max: 1, waitCodes: []})
  .filter(url => url.status === false)
  .map(port => _.last(port.url.split(':')))
  .then(ports => ports[0]);

/*
 * Helper to determine what ports have changed
 */
exports.needsProtocolScan = (current, last, status = {http: true, https: true}) => {
  if (!last) return status;
  if (current.http === last.http) status.http = false;
  if (current.https === last.https) status.https = false;
  return status;
};

/*
 * Helper to parse a url
 */
exports.normalizeRoutes = (services = {}) => Object.fromEntries(_.map(services, (routes, key) => {
  const defaults = {port: '80', pathname: '/', middlewares: []};

  // normalize routes
  routes = routes.map(route => {
    // if route is a string then
    if (typeof route === 'string') route = {hostname: route};

    // url parse hostname with wildcard stuff if needed
    route.hostname = route.hostname.replace(/\*/g, '__wildcard__');

    // if hostname does not start with http:// or https:// then prepend http
    // @TODO: does this allow for protocol selection down the road?
    if (!route.hostname.startsWith('http://') || !route.hostname.startsWith('https://')) {
      route.hostname = `http://${route.hostname}`;
    }

    // at this point we should be able to parse the hostname
    // @TODO: do we need to try/catch this?
    // @NOTE: lets hold off on URL.parse until more people reliable have a node20 ready cli
    // const {hostname, port, pathname} = URL.parse(route.hostname);
    const {hostname, port, pathname} = url.parse(route.hostname);

    // and rebase the whole thing
    route = merge({}, [defaults, {port: _.isNil(port) ? '80' : port, pathname}, route, {hostname}], ['merge:key', 'replace']);

    // wildcard replacement back
    route.hostname = route.hostname.replace(/__wildcard__/g, '*');

    // generate an id based on protocol/hostname/path so we can groupby and dedupe
    route.id = hasher(`${route.hostname}-${route.pathname}`);

    // and return
    return route;
  });

  // merge together all routes with the same id
  routes = _(_.groupBy(routes, 'id')).map((routes, id) => merge({}, routes, ['merge:key', 'replace'])).value();

  // return
  return [key, routes];
}));

/*
 * Helper to get proxy runner
 */
exports.getProxyRunner = (project, files) => ({
  compose: files,
  project: project,
  opts: {
    services: ['proxy'],
    noRecreate: false,
  },
});

/*
 * Helper to get the trafix rule
 */
exports.getRule = rule => {
  // we do this so getRule is backwards campatible with the older rule.host
  const host = rule.hostname ?? rule.host;

  // Start with the rule we can assume
  const hostRegex = host.replace(new RegExp('\\*', 'g'), '{wildcard:[a-z0-9-]+}');
  const rules = [`HostRegexp(\`${hostRegex}\`)`];

  // Add in the path prefix if we can
  if (rule.pathname.length > 1) rules.push(`PathPrefix(\`${rule.pathname}\`)`);

  // return
  return rules.join(' && ');
};

/*
 * Get a list of URLs and their counts
 */
exports.getUrlsCounts = config => _(config)
  .flatMap(service => service)
  .map(url => exports.parseUrl(url))
  .map(data => `${data.host}${data.pathname}`)
  .countBy()
  .value();

/*
 * Parse config into urls we can merge to app.info
 */
exports.parse2Info = (urls, ports, hasCerts = false) => _(urls)
  .map(url => exports.parseUrl(url))
  .flatMap(url => getInfoUrls(url, ports, hasCerts))
  .value();

/*
 * Parse urls into SANS
 */
exports.parse2Sans = urls => _(urls)
  .map(url => exports.parseUrl(url).host)
  .map((host, index) => `DNS.${10+index} = ${host}`)
  .value()
  .join('\n');

/*
 * Parse hosts for traefik
 */
exports.parseConfig = (config, sslReady = []) => _(config)
  .map((urls, service) => ({
    environment: {
      LANDO_PROXY_NAMES: exports.parse2Sans(urls),
    },
    name: service,
    labels: exports.parseRoutes(service, urls, sslReady)}))
  .value();

/*
 * Helper to parse the routes
 */
exports.parseRoutes = (service, urls = [], sslReady, labels = {}) => {
  // Prepare our URLs for traefik
  const rules = _(urls).uniqBy('id').value();

  // Add things into the labels
  _.forEach(rules, rule => {
    // Add some default middleware
    rule.middlewares.push({name: 'lando', key: 'headers.customrequestheaders.X-Lando', value: 'on'});

    // Add in any path stripping middleware we need it
    if (rule.pathname.length > 1) {
      rule.middlewares.push({name: 'stripprefix', key: 'stripprefix.prefixes', value: rule.pathname});
    };

    // Ensure we prefix all middleware with the ruleid
    rule.middlewares = _(rule.middlewares)
      .map(middleware => _.merge({}, middleware, {name: `${rule.id}-${middleware.name}`}))
      .value();

    // Set up all the middlewares
    _.forEach(rule.middlewares, m => {
      labels[`traefik.http.middlewares.${m.name}.${m.key}`] = m.value;
    });

    // Set the http entrypoint
    labels[`traefik.http.routers.${rule.id}.entrypoints`] = 'http';
    labels[`traefik.http.routers.${rule.id}.service`] = `${rule.id}-service`;
    // Rules are grouped by port so the port for any rule should be fine
    labels[`traefik.http.services.${rule.id}-service.loadbalancer.server.port`] = rule.port;
    // Set the route rules
    labels[`traefik.http.routers.${rule.id}.rule`] = exports.getRule(rule);
    // Set none secure middlewares
    labels[`traefik.http.routers.${rule.id}.middlewares`] = _(_.map(rule.middlewares, 'name'))
      .filter(name => !_.endsWith(name, '-secured'))
      .value()
      .join(',');

    // Add https if we can
    if (_.includes(sslReady, service)) {
      labels['io.lando.proxy.has-certs'] = true;
      labels['dev.lando.proxy.has-certs'] = true;
      labels[`traefik.http.routers.${rule.id}-secured.entrypoints`] = 'https';
      labels[`traefik.http.routers.${rule.id}-secured.service`] = `${rule.id}-secured-service`;
      labels[`traefik.http.routers.${rule.id}-secured.rule`] = exports.getRule(rule);
      labels[`traefik.http.routers.${rule.id}-secured.tls`] = true;
      labels[`traefik.http.routers.${rule.id}-secured.middlewares`] = _.map(rule.middlewares, 'name').join(',');
      labels[`traefik.http.services.${rule.id}-secured-service.loadbalancer.server.port`] = rule.port;
    }

    // add the protocols label for testing purposes
    labels['io.lando.proxy.protocols'] = _.includes(sslReady, service) ? 'http,https' : 'http';
    labels['dev.lando.proxy.protocols'] = _.includes(sslReady, service) ? 'http,https' : 'http';
  });
  return labels;
};

/*
 * Helper to parse a url
 */
exports.parseUrl = data => {
  // We add the protocol ourselves, so it can be parsed. We also change all *
  // occurrences for our magic word __wildcard__, because otherwise the url parser
  // won't parse wildcards in the hostname correctly.
  const parsedUrl = _.isString(data) ? url.parse(`http://${data}`.replace(/\*/g, '__wildcard__')) : _.merge({}, data, {
    hostname: data.hostname.replace(/\*/g, '__wildcard__'),
  });

  // If the port is null then set it to 80
  if (_.isNil(parsedUrl.port)) parsedUrl.port = '80';

  // Retranslate and send
  const defaults = {port: '80', pathname: '/', middlewares: []};
  return _.merge(defaults, parsedUrl, {host: parsedUrl.hostname.replace(/__wildcard__/g, '*')});
};

/*
 * Maps ports to urls
 */
exports.ports2Urls = (ports, secure = false, hostname = '127.0.0.1') => _(ports)
  .map(port => url.format({protocol: (secure) ? 'https' : 'http', hostname, port}))
  .value();
