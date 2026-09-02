$app_define$("@quickapp-kit/shared/helper/ajax", ["@quickapp-kit/shared/helper/utils"], function ($app_require$, module, exports) {
  const $fetch = $app_require$("@app-module/system.fetch").default;
  const $utils = $app_require$("@quickapp-kit/shared/helper/utils").default;
  const TIMEOUT = 20000;
  (Promise.prototype.finally = function(callback) { const P = this.constructor; return this.then((value) => P.resolve(callback()).then(() => value), (reason) => P.resolve(callback()).then(() => { throw reason; })); });
  function fetchPromise(params) { return new Promise((resolve, reject) => { $fetch.fetch({ url: params.url, method: params.method, data: params.data }).then((response) => { const result = response.data; const content = JSON.parse(result.data); (content.success ? resolve(content.value) : resolve(content.message)); }).catch((error, code) => { console.log(`🐛 request fail, code = ${code}`); reject(error); }).finally(() => { console.log(`✔️ request @${params.url} has been completed.`); resolve(); }); }); }
  function requestHandle(params, timeout = TIMEOUT) { try { return Promise.race([fetchPromise(params), new Promise((resolve, reject) => { setTimeout(() => { reject(new Error("网络状况不太好，再刷新一次？")); }, timeout); })]); } catch (error) { console.log(error); } }
  module.exports = { default: { post: function(url, params) { return requestHandle({ method: "post", url: url, data: params }); }, get: function(url, params) { return requestHandle({ method: "get", url: $utils.queryString(url, params) }); }, put: function(url, params) { return requestHandle({ method: "put", url: url, data: params }); } } };
});
