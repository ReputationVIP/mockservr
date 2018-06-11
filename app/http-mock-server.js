const http = require('http');
const url = require('url');
const fs = require('fs');
const Velocity = require('velocityjs');
const sleep = require('sleep');
const pathToRegexp = require('path-to-regexp');
const path = require('path');
const mime = require('mime');
const { parse } = require('querystring');
const uniqid = require('./uniqid');

class HttpMockServer {
  constructor(app) {
    this.app = app;
    http
      .createServer((req, res) => {
        let body = null;
        req.on('data', chunk => {
          if (!body) {
            body = '';
          }
          body += chunk;
        });
        req.on('end', () => {
          // build body
          if (body) {
            if (req.headers['content-type']) {
              if (
                req.headers['content-type'] ===
                'application/x-www-form-urlencoded'
              ) {
                req.body = parse(body);
              } else if (req.headers['content-type'] === 'application/json') {
                req.body = JSON.parse(body);
              } else {
                try {
                  req.body = JSON.parse(body);
                } catch (error) {
                  try {
                    req.body = parse(body);
                  } catch (error) {
                    req.body = body;
                  }
                }
              }
            } else {
              req.body = body;
            }
          }

          let foundEndpoint = this.findEndpoint(req);

          if (foundEndpoint !== null) {
            if (Array.isArray(foundEndpoint.response)) {
              let weightResponseIndexes = [];
              foundEndpoint.response.forEach((responseItem, index) => {
                weightResponseIndexes = weightResponseIndexes.concat(
                  new Array(responseItem.weight || 1).fill(index)
                );
              });
              const randIndex =
                weightResponseIndexes[
                  Math.floor(Math.random() * weightResponseIndexes.length)
                ];
              if (randIndex !== undefined) {
                HttpMockServer.writeResponse(
                  req,
                  res,
                  foundEndpoint,
                  foundEndpoint.response[randIndex]
                );
              }
            } else {
              HttpMockServer.writeResponse(
                req,
                res,
                foundEndpoint,
                foundEndpoint.response
              );
            }
          } else {
            res.writeHead(404, {});
          }

          res.end();
        });
      })
      .listen(80);
  }

  static writeResponse(request, response, endpoint, endpointResponse) {
    if (endpointResponse.delay) {
      if (Array.isArray(endpointResponse.delay)) {
        if (endpointResponse.delay.length === 2) {
          sleep.msleep(
            Math.floor(
              Math.random() *
                (endpointResponse.delay[1] - endpointResponse.delay[0])
            ) + endpointResponse.delay[0]
          );
        }
      } else {
        sleep.msleep(endpointResponse.delay);
      }
    }

    response.writeHead(
      endpointResponse.status || 200,
      endpointResponse.headers
    );

    if (endpointResponse.velocity && endpointResponse.velocity.enabled) {
      response.write(
        Velocity.render(
          HttpMockServer.getEndpointBody(endpoint, endpointResponse),
          {
            math: Math,
            req: request,
            endpoint: endpoint,
            context: endpointResponse.velocity.context,
            params: endpoint.params,
          }
        )
      );
    } else {
      response.write(
        HttpMockServer.getEndpointBody(endpoint, endpointResponse)
      );
    }
  }

  static getEndpointPath(endpoint, endpointRequest) {
    let basePath = endpoint.basePath || '';

    if (basePath !== '') {
      basePath = '/' + basePath.replace(/^\//, '');
    }

    return (
      basePath.replace(/\/$/, '') +
      '/' +
      endpointRequest.path.replace(/^\//, '')
    );
  }

  isRequestMatch(endpoint, endpointRequest, request, endpointParams) {
    endpoint.callCount = endpoint.callCount || 0;

    if (endpoint.maxCalls && endpoint.callCount >= endpoint.maxCalls) {
      return false;
    }

    if (endpointRequest.method && request.method !== endpointRequest.method) {
      return false;
    }

    let keys = [];
    const re = pathToRegexp(
      HttpMockServer.getEndpointPath(endpoint, endpointRequest),
      keys
    );
    const params = re.exec(request.path);

    if (params === null) {
      return false;
    }

    let matchQuery = true;

    if (endpointRequest.query) {
      Object.keys(endpointRequest.query).forEach(key => {
        if (!request.query[key]) {
          matchQuery = false;
          return;
        }

        if (!new RegExp(endpointRequest.query[key]).test(request.query[key])) {
          matchQuery = false;
        }
      });
    }

    if (!matchQuery) {
      return false;
    }

    let matchHeader = true;

    if (endpointRequest.headers) {
      Object.keys(endpointRequest.headers).forEach(key => {
        if (!request.headers[key]) {
          matchHeader = false;
          return;
        }

        if (
          !new RegExp(endpointRequest.headers[key]).test(request.headers[key])
        ) {
          matchHeader = false;
        }
      });
    }

    if (!matchHeader) {
      return false;
    }

    let matchBody = true;

    if (endpointRequest.body) {
      if (!request.body) {
        return false;
      }
      Object.keys(endpointRequest.body).forEach(key => {
        if (request.body[key] !== 0 && !request.body[key]) {
          matchBody = false;
          return;
        }

        if (!new RegExp(endpointRequest.body[key]).test(request.body[key])) {
          matchBody = false;
        }
      });
    }

    if (!matchBody) {
      return false;
    }

    keys.forEach((key, index) => {
      endpointParams[key.name] = params[index + 1];
    });

    return true;
  }

  findEndpoint(request) {
    let params = {};
    const urlParse = url.parse(request.url, true);
    request.path = urlParse.pathname;
    request.query = urlParse.query;

    let foundEndpoint = this.app.endpoints.find(endpoint => {
      if (Array.isArray(endpoint.request)) {
        if (
          endpoint.request.find(endpointRequest => {
            return this.isRequestMatch(
              endpoint,
              endpointRequest,
              request,
              params
            );
          })
        ) {
          return true;
        }
      } else {
        if (this.isRequestMatch(endpoint, endpoint.request, request, params)) {
          return true;
        }
      }
    });

    if (!foundEndpoint) {
      return null;
    }

    foundEndpoint.callCount++;
    foundEndpoint = JSON.parse(JSON.stringify(foundEndpoint));
    foundEndpoint.params = params;

    return foundEndpoint;
  }

  static getEndpointBody(endpoint, endpointResponse) {
    if (endpointResponse.body !== undefined) {
      return endpointResponse.body;
    }

    const imageMimeTypes = [
      'image/gif',
      'image/jpeg',
      'image/pjpeg',
      'image/x-png',
      'image/png',
      'image/svg+xml',
    ];

    const bodyFilePath = path.resolve(
      endpoint.currentDirectory,
      endpointResponse.bodyFile
    );

    return fs.readFileSync(
      bodyFilePath,
      imageMimeTypes.indexOf(mime.getType(bodyFilePath)) === -1 ? 'utf8' : null
    );
  }

  static getNewEndpointId() {
    return uniqid();
  }
}

module.exports = HttpMockServer;
