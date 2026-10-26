import React from 'react';
import { id } from './id';
import NodulePanel from './NodulePanel';

/**
 * Heurion 结节面板扩展（PRD T2.2 / W2.1–W2.3、W2.6）。
 * 面板经阅片器子域名上的 /api/viewer/lesions 读写（平台按只读 Cookie 允许的检查放行，写入以医生本人身份留痕）。
 * 由 deploy/viewer/build.sh 复制进 OHIF 源码的 extensions/ 下一起构建，并在 app-config.js 里加进 viewer 模式的右侧面板。
 */
const extension = {
  id,
  getPanelModule: ({ servicesManager, commandsManager }) => [
    {
      name: 'nodules',
      iconName: 'tab-linear',
      iconLabel: '结节',
      label: '结节',
      component: () => <NodulePanel servicesManager={servicesManager} commandsManager={commandsManager} />,
    },
  ],
};

export default extension;
