$app_define$("@quickapp-kit/shared/helper/utils", [], function ($app_require$, module, exports) {
  const prompt = $app_require$("@app-module/system.prompt");
  function queryString(url, query) { let str = []; for (let key in query) { str.push(((key + "=") + query[key])); } let paramStr = str.join("&"); return (paramStr ? `${url}?${paramStr}` : url); }
  function showToast(message = "", duration = 0) { if ((!message)) return; prompt.showToast({ message: message, duration }); }
  module.exports = { default: { showToast, queryString } };
});
