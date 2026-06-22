import { default as EpoxyTransport } from "/epoxy/index.mjs";

function ensureIterable(headers) {
  if (headers && typeof headers === "object" && !Array.isArray(headers) && !(headers instanceof Map) && !headers[Symbol.iterator]) {
    return Object.entries(headers);
  }
  return headers;
}

const _origRequest = EpoxyTransport.prototype.request;
EpoxyTransport.prototype.request = function(remote, method, body, headers, signal) {
  return _origRequest.call(this, remote, method, body, ensureIterable(headers), signal);
};

const _origConnect = EpoxyTransport.prototype.connect;
EpoxyTransport.prototype.connect = function(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
  return _origConnect.call(this, url, protocols, ensureIterable(requestHeaders), onopen, onmessage, onclose, onerror);
};

export default EpoxyTransport;
