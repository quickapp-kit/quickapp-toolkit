$app_define$("@quickapp-kit/shared/helper/apis/index", ["@quickapp-kit/shared/helper/apis/example"], function ($app_require$, module, exports) {
  const files = (function () { const modules = { "./example.js": function () { return $app_require$("@quickapp-kit/shared/helper/apis/example"); } }; const load = function (key) { const factory = modules[key]; if (factory === undefined) { throw new Error("Unknown static module: " + key); } return factory(); }; load.keys = function () { return ["./example.js"]; }; return load; })();
  const modules = {  };
  files.keys().forEach((key) => { if ((key === "./index.js")) { return; } (modules[key.replace(/(^\.\/|\.js$)/g, "")] = files(key).default); });
  module.exports = { default: modules };
});
