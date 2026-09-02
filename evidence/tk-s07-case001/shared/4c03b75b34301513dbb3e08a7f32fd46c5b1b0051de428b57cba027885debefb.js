$app_define$("@quickapp-kit/shared/helper/apis/example", ["@quickapp-kit/shared/helper/ajax"], function ($app_require$, module, exports) {
  const $ajax = $app_require$("@quickapp-kit/shared/helper/ajax").default;
  const baseUrl = "https://api.exampel.com/";
  module.exports = { default: { getApi(data) { return $ajax.get(`${baseUrl}your-project-api`, data); }, postOtherApi(data) { return $ajax.post(`${baseUrl}your-project-api`, data); } } };
});
