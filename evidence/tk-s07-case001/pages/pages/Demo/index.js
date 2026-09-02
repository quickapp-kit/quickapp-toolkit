$app_define$("@quickapp-kit/page/pages/Demo", [], function ($app_require$, module, exports) {
  const router = $app_require$("@app-module/system.router").default;
  const device = $app_require$("@app-module/system.device").default;
  const __qak_reactive_page_vm__ = function (target, context, bindings) {
    let scheduled = false;
    let revision = 0;
    let sequence = 0;
    const dirty = new Set();
    const blockDefinitions = arguments[3] || {};
    let activeBlocks = new Map();
    let activeBlockSlots = new Map();
    const blockGenerations = new Map();
    let proxy;
    const blockSlot = function (definition, key) { return String(definition.templateBlockId) + "\u0000" + String(key); };
    const blockInstanceId = function (definition, key, generation) { const base = "blk:" + context.surfaceId + "-" + String(definition.templateBlockId) + "-" + String(key).replace(/[^A-Za-z0-9_.-]/g, "_"); return generation === 1 ? base : base + "-g" + String(generation); };
    const collectBlocks = function () {
      const result = [];
      const dynamicOffsets = {};
      Object.keys(blockDefinitions).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (id) {
        const definition = blockDefinitions[id];
        const parentKey = String(definition.parentTemplateNodeId);
        const append = function (key, scope) { const offset = dynamicOffsets[parentKey] || 0; result.push({ definition: definition, key: key, scope: scope, index: definition.staticIndex + offset }); dynamicOffsets[parentKey] = offset + 1; };
        if (definition.kind === "if") {
          if (definition.evaluate.call(proxy, {})) append("if", {});
          return;
        }
        const items = definition.evaluate.call(proxy, {});
        if (!Array.isArray(items)) return;
        items.forEach(function (item, index) { const scope = {}; scope[definition.indexAlias] = index; scope[definition.itemAlias] = item; append(definition.key.call(proxy, scope), scope); });
      });
      return result;
    };
    const blockBindings = function (item) {
      const values = {};
      Object.keys(item.definition.bindings).forEach(function (id) { values[id] = item.definition.bindings[id].call(proxy, item.scope); });
      return values;
    };
    const reconcileBlocks = function (initial) {
      const nextBlocks = new Map();
      const operations = [];
      collectBlocks().forEach(function (item) {
        const slot = blockSlot(item.definition, item.key);
        const previousId = activeBlockSlots.get(slot);
        const previous = previousId === undefined ? undefined : activeBlocks.get(previousId);
        const generation = blockGenerations.get(slot) || 0;
        const id = previousId === undefined ? blockInstanceId(item.definition, item.key, generation + 1) : previousId;
        if (previousId === undefined) blockGenerations.set(slot, generation + 1);
        if (previous === undefined) {
          const handlers = item.definition.handlers.map(function (handler) { return { ownerInstanceId: id, templateHandlerId: handler.templateHandlerId, handlerId: "hdl:" + context.surfaceId + "-" + String(handler.templateHandlerId) + "-" + id }; });
          operations.push({ kind: "instantiateBlock", templateBlockId: item.definition.templateBlockId, blockInstanceId: id, parent: { ownerInstanceId: "cmp:" + context.surfaceId, templateNodeId: item.definition.parentTemplateNodeId }, index: item.index, key: item.key, initialBindings: blockBindings(item), handlers: handlers });
        } else if (!initial && previous.index !== item.index) {
          operations.push({ kind: "moveBlock", blockInstanceId: id, parent: { ownerInstanceId: "cmp:" + context.surfaceId, templateNodeId: item.definition.parentTemplateNodeId }, index: item.index });
        }
        nextBlocks.set(id, { definition: item.definition, key: item.key, scope: item.scope, index: item.index, slot: slot });
      });
      if (!initial) activeBlocks.forEach(function (previous, id) { if (!nextBlocks.has(id)) operations.push({ kind: "removeBlock", blockInstanceId: id }); });
      const nextSlots = new Map(); nextBlocks.forEach(function (value, id) { nextSlots.set(value.slot, id); });
      return { operations: operations, nextBlocks: nextBlocks, nextSlots: nextSlots };
    };
    const commitBlocks = function (nextBlocks, nextSlots) { activeBlocks = nextBlocks; activeBlockSlots = nextSlots; };
    const flush = function () {
      scheduled = false;
      if (dirty.size === 0) return;
      const operations = [];
      dirty.forEach(function (id) {
        const binding = bindings[id];
        if (binding === undefined) return;
        operations.push({ kind: "updateBinding", ownerInstanceId: "cmp:" + context.surfaceId, templateBindingId: Number(id), value: binding.evaluate.call(proxy, {}) });
      });
      const blocks = reconcileBlocks(false);
      blocks.operations.forEach(function (operation) { operations.push(operation); });
      if (operations.length === 0) return;
      const nextRevision = revision + 1;
      const causalRequest = globalThis.$quickapp_current_request_id$;
      const message = { schemaVersion: 1, surfaceId: context.surfaceId, transactionId: "txn:" + context.surfaceId + "-" + String(++sequence), revision: nextRevision, operations: operations };
      if (typeof causalRequest === "string" && causalRequest.indexOf("req:") === 0) message.requestId = causalRequest;
      const result = globalThis.$quickapp_runtime_v1_submitRenderTransaction$(message);
      if (result && result.ok === true) { revision = nextRevision; dirty.clear(); commitBlocks(blocks.nextBlocks, blocks.nextSlots); }
    };
    proxy = new Proxy(target, {
      set: function (object, property, value) {
        object[property] = value;
        const name = String(property);
        Object.keys(bindings).forEach(function (id) { if (bindings[id].deps.indexOf(name) >= 0) dirty.add(id); });
        Object.keys(blockDefinitions).forEach(function (id) { if (blockDefinitions[id].deps.indexOf(name) >= 0) dirty.add("__qak_block__"); });
        if (!scheduled) { scheduled = true; Promise.resolve().then(flush); }
        return true;
      }
    });
    const initialBlocks = reconcileBlocks(true);
    commitBlocks(initialBlocks.nextBlocks, initialBlocks.nextSlots);
    Object.defineProperty(proxy, "__qak_initial_blocks__", { value: initialBlocks.operations });
    return proxy;
  };
  module.exports = {
    schemaVersion: 1,
    kind: "page",
    createPageVm: function (context) { return __qak_reactive_page_vm__({ "title": "欢迎体验 quickapp 开发", onInit() { this.$page.setTitleBar({ text: "欢迎体验 quickapp 开发" }); device.getInfo(); if (this.$page.setMeta) { this.$page.setMeta({ title: "quickapp 示例模版", description: "quickapp 是移动互联网新型应用生态，与手机系统深度整合，为用户提供更加场景化的体验。具备传统APP完整的应用体验，但无需安装、即点即用。" }); } }, onDetailBtnClick() { router.push({ uri: "/pages/DemoDetail" }); } }, context, { "1": { deps: ["title"], evaluate: function () { return String(this.title); } } }, {  }); },
    bindingEvaluators: {
      "1": function (scope) { return String(this.title); },
    },
    handlerMethods: {
      "1": "onDetailBtnClick",
    },
  };
});
$app_bootstrap$("@quickapp-kit/page/pages/Demo", {"schemaVersion":1,"kind":"page","moduleId":"@quickapp-kit/page/pages/Demo","templateId":"page:/pages/Demo"});
