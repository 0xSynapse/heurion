/** @type {AppTypes.Config} */
// Heurion 阅片器（OHIF v3.13.12）配置：部署在独立子域名（VIEWER_HOST）根路径，与主站不同源，读不到主站的登录令牌。
// 影像只经该子域名上的 /api/dicomweb（平台按患者权限代理）读取；鉴权靠平台用一次性票据换发的只读 Cookie
// （Path=/api/dicomweb，只对打开过的检查有效），浏览器同源请求自动带上，OHIF 本身不存任何令牌。
// 不开放检查列表（QIDO 只接受指定 StudyInstanceUID 的查询），由患者页「在阅片器中打开」进入。
window.config = {
  name: 'heurion',
  routerBasename: null,
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: false,
  maxNumberOfWebWorkers: 3,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  investigationalUseDialog: { option: 'never' },
  defaultDataSourceName: 'heurion',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'heurion',
      configuration: {
        friendlyName: 'Heurion',
        name: 'heurion',
        wadoUriRoot: '/api/dicomweb',
        qidoRoot: '/api/dicomweb',
        wadoRoot: '/api/dicomweb',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: false,
        staticWado: false,
        singlepart: 'bulkdata,video',
        bulkDataURI: { enabled: true },
        omitQuotationForMultipartRequest: true,
      },
    },
  ],
};
