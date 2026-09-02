$app_define$("@quickapp-kit/app", ["@quickapp-kit/shared/helper/apis/index","@quickapp-kit/shared/helper/utils"], function ($app_require$, module, exports) {
  const $utils = $app_require$("@quickapp-kit/shared/helper/utils").default;
  const $apis = $app_require$("@quickapp-kit/shared/helper/apis/index").default;
  const hook2global = (global.__proto__ || global);
  (hook2global.$utils = $utils);
  (hook2global.$apis = $apis);
  module.exports = {
    schemaVersion: 1,
    kind: "app",
    createAppVm: function (context) { return { onCreate() {  } }; },
  };
});
$app_bootstrap$("@quickapp-kit/app", {"schemaVersion":1,"kind":"app","moduleId":"@quickapp-kit/app"});
