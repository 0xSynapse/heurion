import React from 'react';
import { id } from './id';
import NodulePanel from './NodulePanel';

/**
 * Heurion 结节面板扩展（PRD T2.2 / W2.1–W2.3、W2.6；T2.3 点选补漏与修边界）。
 * 面板经阅片器子域名上的 /api/viewer/lesions 读写（平台按只读 Cookie 允许的检查放行，写入以医生本人身份留痕）。
 * 由 deploy/viewer/build.sh 复制进 OHIF 源码的 extensions/ 下一起构建，并在 app-config.js 里加进 viewer 模式的右侧面板。
 */
const PANEL_ID = `${id}.panelModule.nodules`;

const extension = {
  id,
  /**
   * 打开阅片器时展开右侧面板并切到「结节」。OHIF 默认收起右侧面板，面板组件没挂载，
   * 结节列表看不到，审核视图「跳转」（定位逻辑在面板里）也不会执行（2026-11-03 生产上发现）。
   * activatePanel 只是广播事件，侧栏还没渲染时会丢，所以重试到面板出现为止（最多约 30 秒）。
   */
  onModeEnter: ({ servicesManager }) => {
    const { panelService } = servicesManager.services;
    let tries = 0;
    const tick = () => {
      if (document.querySelector('[data-cy="heurion-nodule-panel"]') || tries >= 60) return;
      tries += 1;
      if (panelService.getPanels('right').some(p => p.id === PANEL_ID)) panelService.activatePanel(PANEL_ID, true);
      setTimeout(tick, 500);
    };
    setTimeout(tick, 300);
  },
  getPanelModule: ({ servicesManager, commandsManager, extensionManager }) => [
    {
      name: 'nodules',
      iconName: 'tab-linear',
      iconLabel: '结节',
      label: '结节',
      component: () => <NodulePanel servicesManager={servicesManager} commandsManager={commandsManager} extensionManager={extensionManager} />,
    },
  ],
};

export default extension;
