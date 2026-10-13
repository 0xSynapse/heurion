/**
 * Heurion 2.0 Demo Deck Generator (Mantle Theme & Rich Diagrams - Pure Technical Style, Zero Emoji)
 * Matches the official Heurion homepage (apps/site/index.html & site.css)
 * Generates:
 * 1. Native PowerPoint (.pptx) file via @heurion2/platform deck engine
 * 2. High-aesthetic Standalone Interactive HTML Presentation (.html) with rich SVG diagrams
 */

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../apps/platform/src/store/db.ts';
import { Documents } from '../apps/platform/src/model/runtime.ts';
import { OpService } from '../apps/platform/src/ops/service.ts';
import { pptxTemplate } from '../apps/platform/src/convert/pptx-template.ts';
import { readLayouts } from '../apps/platform/src/convert/pptx-layouts.ts';
import { newDeckContent } from '../apps/platform/src/ops/deck.ts';
import { exportPptx } from '../apps/platform/src/convert/pptx-export.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SITE_DIR = path.join(ROOT_DIR, 'apps/site');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const WORKSPACE_DIR = path.resolve(ROOT_DIR, '..');

interface SlideData {
  title: string;
  subtitle?: string;
  layout: string;
  category: string;
  body: string;
  body2?: string;
  image?: string;
  diagramKey?: string;
  notes?: string;
}

// 幻灯片内容以当前代码的实际能力为准：不写编造的病例、研究数据与测量值；
// 配图只引用 scripts/generate_all_case_study_images.py 在公开数据集样本上生成的 demo-*.png。
const SLIDES: SlideData[] = [
  {
    title: '临床科研，从数据沉淀到成果发表的全流程工作台',
    subtitle: '面向临床科研的 AI 辅助工作台 (Clinical Research AI Workstation)',
    layout: 'cover',
    category: 'OVERVIEW - 平台总览',
    body: '汇报人：Heurion 团队\n官方主页：https://heurion.org | 工作台入口：https://heurion.org/app\n底层组成：@heurion2/platform + apps/imaging-worker (MONAI / PyTorch)',
    diagramKey: 'cover_pipeline',
    notes: '开场：Heurion 把患者入组、影像量化、沙箱统计、Table 1 与引用核验放在同一个工作台里。所有 AI 输出都需要作者审阅确认，平台不提供诊断。'
  },
  {
    title: '通用 AI 用于临床科研的四个难点',
    subtitle: '通用聊天工具缺少面向临床科研的数据、计算与引用基础设施',
    layout: 'two_col',
    category: 'CHALLENGE - 行业痛点',
    body: '### 通用大模型的四个难点\n- **1. 隐私**：直接粘贴病历有泄露风险，缺少去标识流程\n- **2. 队列与计算**：不能直接查询结构化数据，也不能处理三维影像\n- **3. 记忆**：对话窗口用尽后，研究假设与纳排口径需要反复交代\n- **4. 引用**：可能虚构 PMID/DOI，整段改写难以追踪',
    body2: '### Heurion 的做法\n- **1. 去标识与 PHI 扫描**：入组即分配 S001... 编号；基于规则的 PHI 扫描工具检出身份证号、手机号、病案号等\n- **2. 结构化纳排**：组合条件筛选队列，按真实入组记录生成 CONSORT 流向图\n- **3. 课题记忆**：AI 只能提议记忆条目，经作者确认后生效\n- **4. 引用核验与写前守卫**：正式引用只能来自已登记的 PubMed / Crossref 记录，修改以行内差异呈现',
    diagramKey: 'pain_vs_solution',
    notes: '强调平台的定位是辅助：减少重复劳动与常见错误，结论与责任仍在研究者。'
  },
  {
    title: '系统架构',
    subtitle: '平台服务、影像计算服务与隔离沙箱',
    layout: 'diagram_focused',
    category: 'ARCHITECTURE - 系统架构',
    body: '- **@heurion2/platform (:8787)**：Hono REST API、Yjs 协同、多租户隔离、文档操作层与引用守卫、MCP 服务\n- **apps/imaging-worker (:8004)**：MONAI + PyTorch 影像计算服务，接入多款 MONAI Model Zoo 官方权重与若干阈值法算法，完成度不一\n- **隔离沙箱**：每个平台用户一个独立 Linux 用户，运行 Python 统计环境（pandas、statsmodels、lifelines 等，未安装 R），出站网络只放行平台端口\n- **部署方式**：单机 Docker Compose',
    diagramKey: 'system_architecture',
    notes: '说明各组件职责与隔离边界；如被问到 R，如实说明当前只提供 Python。'
  },
  {
    title: '患者数据建档与化验追踪',
    subtitle: '化验单、出院小结 OCR 提取，纵向追踪与受控分享',
    layout: 'content',
    category: 'DATA ASSET - 患者档案',
    body: '- **OCR 结构化提取**：上传化验单、出院小结图片或 PDF，提取指标数值与参考区间，结果经人工核对后入库\n- **纵向趋势**：同一指标跨时间点对齐，查看趋势图并可回到原件核对\n- **知家 (PHR) 与限时授权**：患者通过限时、限范围的口令把资料分享给研究团队\n- **去标识**：患者以研究代号建档；医生添加的备注名只保存在本机浏览器',
    diagramKey: 'data_ingestion_flow',
    notes: '现场演示请使用演示数据，不要使用真实患者资料。'
  },
  {
    title: '三维影像：方向规范与三正交 MPR',
    subtitle: '统一到 LPS 方向，按物理间距显示与测量',
    layout: 'image_text',
    category: 'IMAGING - 3D 影像',
    image: 'demo-chest-mpr-3view.png',
    body: '- **方向规范**：NIfTI / DICOM 统一转换到 LPS：轴位上方为前、图像左侧为患者右\n- **物理间距**：保留原始体素间距，长度、面积与体积按真实间距换算\n- **三正交切片**：轴位、冠状位、矢状位联动浏览，提供肺窗、纵隔窗、腹部窗、骨窗与脑窗预设\n- **配图**：公开数据集样本 chest_lung_ct 的三正交重建，十字定位在体数据几何中心，无病灶标注',
    diagramKey: 'mpr_coordinate_diagram',
    notes: '配图为公开数据集样本上的实际输出，不是临床病例。'
  },
  {
    title: 'MONAI 脾脏分割（公开样本上的实际推理）',
    subtitle: 'MONAI Model Zoo 官方 spleen_ct 3D-UNet 权重',
    layout: 'image_text',
    category: 'IMAGING - 模型推理',
    image: 'demo-spleen-monai-segmentation.png',
    body: '- **数据**：公开数据集样本 spleen_test（腹部 CT）\n- **算法**：spleen_ct 3D-UNet 滑窗推理 + RECIST 径线与体积计算\n- **本次结果**：分割体积 127.89 cm³，最大截面最长径 87.8 mm\n- **模型现状**：其他已接入的模型完成度不一（如前列腺在现有样本上输出为空），对外只展示已验证的结果',
    diagramKey: 'recist_pipeline_diagram',
    notes: '数值来自 scripts/generate_all_case_study_images.py 的实际运行结果，可以现场复现。'
  },
  {
    title: 'RECIST 1.1 径线测量与影像组学特征',
    subtitle: '基于分割掩膜的最长径、体积与 46 项组学特征',
    layout: 'image_text',
    category: 'IMAGING - 量化测量',
    image: 'demo-lidc-nodule-recist.png',
    body: '- **数据**：公开数据集样本 lidc_lung_nodule_ct，ROI 使用样本附带的结节标注掩膜\n- **RECIST 测量**：最大截面层最长径 31.2 mm、垂直方向最大跨度 26.2 mm、体积 7.47 cm³；疗效分级由医师判定\n- **影像组学**：形状、一阶统计、GLCM、GLRLM 共 46 项特征，可存入研究数据集；尚未与 IBSI 参考值做一致性校验\n- **单一时间点**：不涉及疗效评估与随访对比',
    diagramKey: 'radiomics_card_diagram',
    notes: '强调 ROI 是样本附带的标注，不是平台自动检出。'
  },
  {
    title: '受试者纳排与 CONSORT 流向图',
    layout: 'content',
    category: 'COHORT - 课题纳排',
    body: '- **组合条件筛选**：按人口学、诊断标签、化验区间与影像测量值组合筛选候选受试者\n- **去标识编号**：入组即分配 S001... 研究编号\n- **CONSORT 2010 流向图**：默认只画平台真实入组记录（入组 / 移出 / 在组）；筛选、排除与分组人数由研究者按原始记录填写，平台不估算\n- **导出**：SVG 矢量图与 Mermaid 源码',
    diagramKey: 'consort_flow_diagram',
    notes: '流向图中的人数必须来自真实记录。'
  },
  {
    title: '发表级 Table 1 原生 Word (.docx) 导出',
    subtitle: '三线表排版与统计检验自动选择',
    layout: 'content',
    category: 'EVIDENCE - 原生三线表',
    body: '- **原生 Word 格式 (OpenXML)**：三线表、宋体 / Times New Roman 排版与统计脚注\n- **检验方法自适应**：\n  - 正态连续变量：Mean ± SD (t 检验)\n  - 偏态连续变量：Median [IQR] (Mann-Whitney U 检验)\n  - 分类变量：n (%)，期望频数小时用 Fisher 精确检验，否则卡方检验\n- **组间平衡**：两组比较时可给出标准化均数差 (SMD)；平台不提供倾向评分匹配',
    diagramKey: 'table1_pipeline_diagram',
    notes: '如被问到 PSM，如实说明目前不提供，需在沙箱中自行编写。'
  },
  {
    title: '生存分析与 E-value 敏感性分析',
    subtitle: '在隔离沙箱中运行 Python 统计脚本',
    layout: 'two_col',
    category: 'STATISTICS - 统计分析',
    body: '### 生存分析\n- **Kaplan-Meier 曲线**：带风险人数表与 Log-rank 检验\n- **Cox 比例风险回归**：输出 HR 与 95% CI，可绘制森林图\n- 所有图表只用研究中真实入组受试者的数据生成',
    body2: '### 未测混杂敏感性分析\n- **VanderWeele E-value**：由效应量计算点估计与置信区间界限对应的 E-value\n- **结果表述**：生成中英文描述段落，供作者回复审稿意见时参考修改\n- **暂未开放**：列线图、ROC / DCA 与倾向评分匹配',
    diagramKey: 'causal_survival_diagram',
    notes: '演示时使用演示数据集，并说明暂未开放的功能。'
  },
  {
    title: '引用核验与写前守卫',
    subtitle: '正式引用只能来自已登记的文献记录',
    layout: 'diagram_focused',
    category: 'GROUNDING - 引用核验',
    body: '### 三道防护\n- **1. 文献登记**：引用须经 PubMed / Crossref / Europe PMC 检索登记后才能插入正文\n- **2. 论断核查 (verify_claims)**：抽取正文中的效应量（HR、OR、95% CI 等）与已登记文献比对，标记支持状态\n- **3. 写前守卫**：AI 的修改以行内差异呈现，由作者逐条采纳；未登记的引用标记在操作层被拦截',
    diagramKey: 'pubmed_guard_diagram',
    notes: '核验能降低虚构引用的风险，但仍需作者阅读原文。'
  },
  {
    title: '文档与幻灯片双模协同、课题记忆',
    subtitle: '同一份课题内容，产出论文手稿与汇报幻灯片',
    layout: 'two_col',
    category: 'WORKSPACE - 双模协同',
    body: '### Docs & Slides\n- 论文长文与 16:9 幻灯片两种形态\n- 多种学术版式与主题\n- 导出 Word / PPTX',
    body2: '### 课题记忆\n- AI 从修订与确认中提出记忆条目（研究假设、变量定义、偏好）\n- 条目经作者确认后生效，可更新或退役',
    diagramKey: 'dual_mode_memory_diagram',
    notes: '记忆的生效权在作者。'
  },
  {
    title: '与通用大模型、传统工具的对比',
    subtitle: '按当前已实现的能力对比',
    layout: 'content',
    category: 'COMPARISON - 对比',
    body: `### 对比

| 评估维度 | Heurion | 通用大模型 (ChatGPT / Claude) | 传统工具 (SPSS / Excel / PACS) |
| :--- | :--- | :--- | :--- |
| **引用核验** | 正式引用来自已登记记录，无法核实的会被标出 | 可能虚构 DOI/PMID | 人工逐篇检索 |
| **三维影像** | MONAI 分割、RECIST 径线与体积、三正交 MPR | 只能看二维截图 | 需另装 PACS 或 3D Slicer |
| **隐私** | 入组去标识、PHI 扫描、统计代码在隔离沙箱运行 | 直接粘贴病历有泄露风险 | 本地文件，缺少自动去标识 |
| **纳排与流向图** | 组合筛选，按真实入组记录生成 CONSORT 图 | 不能直接查询数据 | 手写 SQL 或 Excel 公式 |
| **Table 1** | 原生 Word 三线表与检验脚注 | 输出 Markdown 需重新排版 | 手工复制到 Word |
| **统计计算** | 隔离沙箱运行 Python | 只给代码，不负责执行 | 手动操作界面 |
| **Agent 接入** | 提供 MCP 服务 | 通用对话 | 无 |`,
    diagramKey: 'comparison_matrix_diagram',
    notes: '对比只列当前已实现的能力。'
  },
  {
    title: '路线图',
    subtitle: '已就绪的能力与规划中的方向',
    layout: 'closing',
    category: 'ROADMAP - 路线图',
    body: '- **已就绪**：患者建档与去标识、受试者纳排、MONAI 脾脏分割与 RECIST 测量、原生 Table 1 与 CONSORT 流向图、引用核验、Docs & Slides、MCP 接入\n- **实验中**：形变配准、PET-CT 与放疗靶区演示（目前只在合成数据上运行）、多款 MONAI 模型的验证\n- **规划中**：多中心协作、列线图与 ROC / DCA、倾向评分匹配\n\n官方联系：support@heurion.org | 平台体验：https://heurion.org/app\n感谢聆听，欢迎交流。',
    diagramKey: 'roadmap_airgap_diagram',
    notes: '如实区分已就绪、实验中与规划中的能力。'
  }
];

// 幻灯片配图用的 HTML 示意（纯文字说明，不含编造数据）
const DIAGRAMS: Record<string, string> = {
  cover_pipeline: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">模块 01 / 数据</div><div class="diag-card-title">化验单 OCR & PHR</div><div class="diag-card-desc">病历与化验单结构化提取，人工核对后入库</div></div>
        <div class="diag-card"><div class="diag-card-h">模块 02 / 影像</div><div class="diag-card-title">MONAI & MPR</div><div class="diag-card-desc">分割、RECIST 径线与体积、三正交浏览</div></div>
        <div class="diag-card"><div class="diag-card-h">模块 03 / 统计</div><div class="diag-card-title">隔离沙箱 Python</div><div class="diag-card-desc">原生 Word 三线表、KM 曲线、E-value</div></div>
        <div class="diag-card"><div class="diag-card-h">模块 04 / 写作</div><div class="diag-card-title">引用核验 & 双模</div><div class="diag-card-desc">登记文献才能引用，手稿与幻灯片同步</div></div>
      </div>
    </div>
  `,

  pain_vs_solution: `
    <div class="diagram-wrap">
      <div class="diagram-split">
        <div class="diag-side red">
          <div class="diag-side-h">[通用大模型的难点]</div>
          <div class="diag-node-list">
            <div class="diag-node red"><b>1. 隐私</b><span>直接粘贴病历有泄露风险</span></div>
            <div class="diag-node red"><b>2. 队列与计算</b><span>不能查询结构化数据，不能处理三维影像</span></div>
            <div class="diag-node red"><b>3. 记忆</b><span>窗口用尽后需要反复交代研究背景</span></div>
            <div class="diag-node red"><b>4. 引用</b><span>可能虚构 PMID/DOI</span></div>
          </div>
        </div>
        <div class="diag-center-divider"><span class="chasm-tag">VS</span></div>
        <div class="diag-side green">
          <div class="diag-side-h">[Heurion 的做法]</div>
          <div class="diag-node-list">
            <div class="diag-node green"><b>1. 去标识与 PHI 扫描</b><span>S001... 研究编号；规则扫描身份证号、手机号、病案号</span></div>
            <div class="diag-node green"><b>2. 结构化纳排与影像量化</b><span>组合筛选；MONAI 分割与 RECIST 测量</span></div>
            <div class="diag-node green"><b>3. 课题记忆</b><span>AI 提议，作者确认后生效</span></div>
            <div class="diag-node green"><b>4. 引用核验</b><span>登记文献才能引用，修改以行内差异呈现</span></div>
          </div>
        </div>
      </div>
    </div>
  `,

  system_architecture: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">平台服务</div><div class="diag-card-title">@heurion2/platform</div><div class="diag-card-desc">REST API、协同、多租户、操作层与引用守卫、MCP</div></div>
        <div class="diag-card"><div class="diag-card-h">影像服务</div><div class="diag-card-title">imaging-worker</div><div class="diag-card-desc">MONAI + PyTorch；模型完成度不一</div></div>
        <div class="diag-card"><div class="diag-card-h">隔离沙箱</div><div class="diag-card-title">独立 Linux 用户</div><div class="diag-card-desc">Python 统计环境，出站只放行平台端口</div></div>
        <div class="diag-card"><div class="diag-card-h">部署</div><div class="diag-card-title">Docker Compose</div><div class="diag-card-desc">单机部署，Caddy 反向代理</div></div>
      </div>
    </div>
  `,

  data_ingestion_flow: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">步骤 1</div><div class="diag-card-title">上传原件</div><div class="diag-card-desc">图片或 PDF</div></div>
        <div class="diag-card"><div class="diag-card-h">步骤 2</div><div class="diag-card-title">OCR 提取</div><div class="diag-card-desc">指标、数值、单位与参考区间</div></div>
        <div class="diag-card"><div class="diag-card-h">步骤 3</div><div class="diag-card-title">人工核对</div><div class="diag-card-desc">待确认卡逐项确认后入库</div></div>
        <div class="diag-card"><div class="diag-card-h">步骤 4</div><div class="diag-card-title">纵向追踪</div><div class="diag-card-desc">趋势图，可回到原件核对</div></div>
      </div>
    </div>
  `,

  mpr_coordinate_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">轴位</div><div class="diag-card-title">上 A / 左 R</div><div class="diag-card-desc">前在上，患者右在图像左</div></div>
        <div class="diag-card"><div class="diag-card-h">冠状位</div><div class="diag-card-title">上 S / 左 R</div><div class="diag-card-desc">头侧在上</div></div>
        <div class="diag-card"><div class="diag-card-h">矢状位</div><div class="diag-card-title">上 S / 左 A</div><div class="diag-card-desc">头侧在上，前在左</div></div>
      </div>
    </div>
  `,

  recist_pipeline_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">输入</div><div class="diag-card-title">CT 体数据</div><div class="diag-card-desc">统一到 LPS 方向</div></div>
        <div class="diag-card"><div class="diag-card-h">分割</div><div class="diag-card-title">模型或标注掩膜</div><div class="diag-card-desc">模型输出需人工核对</div></div>
        <div class="diag-card"><div class="diag-card-h">测量</div><div class="diag-card-title">最长径与体积</div><div class="diag-card-desc">按真实体素间距换算</div></div>
      </div>
    </div>
  `,

  radiomics_card_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">形状</div><div class="diag-card-title">15 项</div><div class="diag-card-desc">体积、表面积、球形度等</div></div>
        <div class="diag-card"><div class="diag-card-h">一阶统计</div><div class="diag-card-title">18 项</div><div class="diag-card-desc">均值、分位数、偏度、峰度、熵等</div></div>
        <div class="diag-card"><div class="diag-card-h">纹理</div><div class="diag-card-title">GLCM 6 / GLRLM 7</div><div class="diag-card-desc">尚未与 IBSI 参考值校验</div></div>
      </div>
    </div>
  `,

  consort_flow_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">平台记录</div><div class="diag-card-title">入组 / 移出 / 在组</div><div class="diag-card-desc">默认只画真实入组记录</div></div>
        <div class="diag-card"><div class="diag-card-h">研究者填写</div><div class="diag-card-title">筛选与排除</div><div class="diag-card-desc">按原始纳排记录填写，平台不估算</div></div>
        <div class="diag-card"><div class="diag-card-h">导出</div><div class="diag-card-title">SVG / Mermaid</div><div class="diag-card-desc">可直接插入论文</div></div>
      </div>
    </div>
  `,

  table1_pipeline_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">检验选择</div><div class="diag-card-title">正态性判断</div><div class="diag-card-desc">t 检验 / Mann-Whitney U / 卡方 / Fisher</div></div>
        <div class="diag-card"><div class="diag-card-h">组间比较</div><div class="diag-card-title">p 值与 SMD</div><div class="diag-card-desc">两组时可给出 SMD</div></div>
        <div class="diag-card"><div class="diag-card-h">导出</div><div class="diag-card-title">原生 .docx</div><div class="diag-card-desc">三线表与统计脚注</div></div>
      </div>
    </div>
  `,

  causal_survival_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">生存分析</div><div class="diag-card-title">KM 与 Log-rank</div><div class="diag-card-desc">带风险人数表</div></div>
        <div class="diag-card"><div class="diag-card-h">回归</div><div class="diag-card-title">Cox 比例风险</div><div class="diag-card-desc">HR 与 95% CI，森林图</div></div>
        <div class="diag-card"><div class="diag-card-h">敏感性分析</div><div class="diag-card-title">E-value</div><div class="diag-card-desc">点估计与置信区间界限</div></div>
      </div>
    </div>
  `,

  pubmed_guard_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">防护 1</div><div class="diag-card-title">文献登记</div><div class="diag-card-desc">PubMed / Crossref / Europe PMC 检索登记</div></div>
        <div class="diag-card"><div class="diag-card-h">防护 2</div><div class="diag-card-title">论断核查</div><div class="diag-card-desc">效应量与登记文献比对，标记支持状态</div></div>
        <div class="diag-card"><div class="diag-card-h">防护 3</div><div class="diag-card-title">写前守卫</div><div class="diag-card-desc">未登记引用在操作层被拦截</div></div>
      </div>
    </div>
  `,

  dual_mode_memory_diagram: `
    <div class="diagram-wrap">
      <div class="diagram-cards-row">
        <div class="diag-card"><div class="diag-card-h">Docs</div><div class="diag-card-title">论文手稿</div><div class="diag-card-desc">导出 Word</div></div>
        <div class="diag-card"><div class="diag-card-h">Slides</div><div class="diag-card-title">汇报幻灯片</div><div class="diag-card-desc">导出 PPTX</div></div>
        <div class="diag-card"><div class="diag-card-h">Memory</div><div class="diag-card-title">课题记忆</div><div class="diag-card-desc">AI 提议，作者确认</div></div>
      </div>
    </div>
  `,

  comparison_matrix_diagram: `
    <div class="diagram-wrap">
      <div class="radar-badges-row">
        <div class="r-badge mint">[引用]: 登记文献才能引用</div>
        <div class="r-badge cyan">[影像]: MONAI 分割与 RECIST 测量</div>
        <div class="r-badge green">[隐私]: 去标识 + 隔离沙箱</div>
        <div class="r-badge yellow">[交付]: 原生 Word 三线表 + 幻灯片</div>
      </div>
    </div>
  `,

  roadmap_airgap_diagram: `
    <div class="diagram-wrap">
      <div class="roadmap-grid">
        <div class="rm-phases">
          <div class="rm-p done"><b>已就绪</b>: 患者建档、受试者纳排、MONAI 脾脏分割与 RECIST 测量、原生 Table 1 与 CONSORT、引用核验、MCP</div>
          <div class="rm-p active"><b>实验中</b>: 形变配准、PET-CT 与放疗靶区演示（合成数据）、更多 MONAI 模型的验证</div>
          <div class="rm-p"><b>规划中</b>: 多中心协作、列线图与 ROC / DCA、倾向评分匹配</div>
        </div>
      </div>
    </div>
  `
};

async function generatePptx(): Promise<string> {
  console.log('Generating Native PPTX Deck via @heurion2/platform...');
  const store = new Store(':memory:');
  const docs = new Documents(store);
  const ops = new OpService(docs);

  const pkg = pptxTemplate('clinical');
  const { layouts } = readLayouts(pkg);

  const assetMap = new Map<string, string>();
  for (const s of SLIDES) {
    if (s.image && !assetMap.has(s.image)) {
      const imgPath = path.join(SITE_DIR, s.image);
      if (fs.existsSync(imgPath)) {
        const bytes = fs.readFileSync(imgPath);
        const asset = store.putAsset({
          owner: 'u',
          mime: 'image/png',
          name: s.image,
          bytes
        });
        assetMap.set(s.image, asset.id);
      }
    }
  }

  const row = docs.create({
    owner: 'u',
    title: 'Heurion 2.0 演示文稿',
    kind: 'deck',
    content: newDeckContent(layouts, SLIDES[0]!.title)
  });
  store.putPackage(row.id, 'pptx', pkg);

  let curDoc = docs.get(row.id);
  const [firstSlideId] = curDoc.content.toJSON().map((s: any) => s.attrs.id);

  const slide1Shapes: any[] = [];
  curDoc.child(0).forEach((s: any) => {
    if (s.type.name === 'shape') slide1Shapes.push({ id: s.attrs.id, ph: s.attrs.ph });
  });
  const subTitleShape = slide1Shapes.find(s => s.ph === 'subTitle');
  if (subTitleShape) {
    ops.edit({
      doc_id: row.id,
      base_rev: 0,
      mode: 'apply',
      ops: [
        { op: 'set_text', shape_id: subTitleShape.id, markdown: SLIDES[0]!.body }
      ]
    }, { actor: 'ai', turnId: null });
  }

  let prevSlideId = firstSlideId;
  let rev = 1;

  for (let i = 1; i < SLIDES.length; i++) {
    const s = SLIDES[i]!;
    const layoutKey = s.layout === 'two_col' ? 'Two Content'
                    : s.layout === 'image_text' ? 'Picture with Caption'
                    : s.layout === 'closing' ? 'Closing'
                    : 'Title and Content';

    const addSlideOp: any = {
      op: 'add_slide',
      after: prevSlideId,
      layout: layoutKey,
      title: s.title,
      body: s.body
    };
    if (s.body2) addSlideOp.body2 = s.body2;

    const res = ops.edit({
      doc_id: row.id,
      base_rev: rev++,
      mode: 'apply',
      ops: [addSlideOp]
    }, { actor: 'ai', turnId: null });

    const newSlideId = res.results[0]!.ids[0]!;

    if (s.notes) {
      ops.edit({
        doc_id: row.id,
        base_rev: rev++,
        mode: 'apply',
        ops: [{ op: 'set_notes', slide_id: newSlideId, markdown: s.notes }]
      }, { actor: 'ai', turnId: null });
    }

    if (s.image && assetMap.has(s.image)) {
      const assetId = assetMap.get(s.image)!;
      ops.edit({
        doc_id: row.id,
        base_rev: rev++,
        mode: 'apply',
        ops: [{
          op: 'add_image',
          slide_id: newSlideId,
          asset_id: assetId,
          x: 40,
          y: 110,
          w: 420,
          h: 360,
          description: s.title
        }]
      }, { actor: 'ai', turnId: null });
    }

    prevSlideId = newSlideId;
  }

  const exported = exportPptx({
    doc: docs.get(row.id),
    baseline: null,
    pkg: store.getPackage(row.id)!,
    src: id => store.getNodeSrc(row.id, id),
    citations: [],
    asset: id => {
      const a = store.getAsset(id);
      return a ? { mime: a.mime, bytes: a.bytes } : null;
    }
  });

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const pptxPath = path.join(DATA_DIR, 'heurion_demo_deck.pptx');
  fs.writeFileSync(pptxPath, exported.bytes);

  const rootPptxPath = path.join(WORKSPACE_DIR, 'heurion_demo_deck.pptx');
  fs.copyFileSync(pptxPath, rootPptxPath);

  console.log(`PPTX exported successfully: ${rootPptxPath} (${exported.bytes.length} bytes)`);
  return rootPptxPath;
}

function generateHtmlPresentation(): string {
  console.log('Generating Mantle-Themed Interactive HTML Presentation with SVG Diagrams (Zero Emoji)...');
  
  const imageMap: Record<string, string> = {};
  for (const s of SLIDES) {
    if (s.image && !imageMap[s.image]) {
      const p = path.join(SITE_DIR, s.image);
      if (fs.existsSync(p)) {
        const b64 = fs.readFileSync(p).toString('base64');
        imageMap[s.image] = `data:image/png;base64,${b64}`;
      }
    }
  }

  const slidesHtml = SLIDES.map((s, idx) => {
    let mainContentHtml = '';
    const diagramHtml = s.diagramKey && DIAGRAMS[s.diagramKey] ? DIAGRAMS[s.diagramKey] : '';
    
    if (s.layout === 'cover') {
      mainContentHtml = `
        <div class="slide-cover">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <h1 class="cover-title">${s.title}</h1>
          <p class="cover-subtitle">${s.subtitle || ''}</p>
          <div class="cover-body">${renderMarkdown(s.body)}</div>
          ${diagramHtml}
        </div>
      `;
    } else if (s.layout === 'two_col') {
      mainContentHtml = `
        <div class="slide-top">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <div class="slide-header">
            <span class="slide-num">${String(idx + 1).padStart(2, '0')}</span>
            <h2>${s.title}</h2>
          </div>
          ${s.subtitle ? `<p class="slide-sub">${s.subtitle}</p>` : ''}
        </div>
        ${diagramHtml}
        <div class="two-col-grid">
          <div class="col-panel red-border">${renderMarkdown(s.body)}</div>
          <div class="col-panel green-border">${renderMarkdown(s.body2 || '')}</div>
        </div>
      `;
    } else if (s.layout === 'image_text') {
      const imgData = s.image && imageMap[s.image] ? imageMap[s.image] : '';
      mainContentHtml = `
        <div class="slide-top">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <div class="slide-header">
            <span class="slide-num">${String(idx + 1).padStart(2, '0')}</span>
            <h2>${s.title}</h2>
          </div>
          ${s.subtitle ? `<p class="slide-sub">${s.subtitle}</p>` : ''}
        </div>
        ${diagramHtml}
        <div class="img-text-grid">
          <div class="img-panel">
            <div class="mock-window-bar">
              <span class="win-dot red"></span><span class="win-dot yellow"></span><span class="win-dot green"></span>
              <span class="win-title">${s.image || 'CT/MRI Volumetric View'}</span>
            </div>
            ${imgData ? `<img src="${imgData}" alt="${s.title}" class="slide-screenshot" />` : '<div class="img-ph">Image</div>'}
            <div class="img-meta">真实 DICOM/NIfTI 切片 - 亚毫米物理体素标定</div>
          </div>
          <div class="text-panel">${renderMarkdown(s.body)}</div>
        </div>
      `;
    } else if (s.layout === 'diagram_focused') {
      mainContentHtml = `
        <div class="slide-top">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <div class="slide-header">
            <span class="slide-num">${String(idx + 1).padStart(2, '0')}</span>
            <h2>${s.title}</h2>
          </div>
          ${s.subtitle ? `<p class="slide-sub">${s.subtitle}</p>` : ''}
        </div>
        ${diagramHtml}
        <div class="diag-focused-desc">${renderMarkdown(s.body)}</div>
      `;
    } else if (s.layout === 'closing') {
      mainContentHtml = `
        <div class="slide-closing">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <h2>${s.title}</h2>
          <p class="slide-sub">${s.subtitle || ''}</p>
          ${diagramHtml}
          <div class="closing-desc">${renderMarkdown(s.body)}</div>
        </div>
      `;
    } else {
      mainContentHtml = `
        <div class="slide-top">
          <div class="eyebrow"><span class="dot"></span>${s.category}</div>
          <div class="slide-header">
            <span class="slide-num">${String(idx + 1).padStart(2, '0')}</span>
            <h2>${s.title}</h2>
          </div>
          ${s.subtitle ? `<p class="slide-sub">${s.subtitle}</p>` : ''}
        </div>
        ${diagramHtml}
        <div class="content-panel">${renderMarkdown(s.body)}</div>
      `;
    }

    return `
      <section class="slide" id="slide-${idx}">
        <div class="slide-inner">
          ${mainContentHtml}
          ${s.notes ? `<aside class="speaker-notes" data-notes="true"><b>[现场实机演练讲者剧本]:</b> ${s.notes}</aside>` : ''}
        </div>
      </section>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Heurion 2.0 · 临床科研全流程智能工作台 (Mantle Demo Deck)</title>
  <style>
    /* Heurion 官网 Mantle 风格：深墨绿底、薄荷绿强调、1px 细线、直角、Mono 标签 (零 Emoji) */
    :root {
      --bg: #06110d;
      --bg-deep: #040f0b;
      --panel: #08150f;
      --raised: #0d1d17;
      --line: #1e2925;
      --line-strong: #2d3d37;
      --text: #ffffff;
      --text-2: rgba(255, 255, 255, 0.75);
      --muted: rgba(255, 255, 255, 0.55);
      --faint: rgba(255, 255, 255, 0.32);
      --mint: #00ff93;
      --mint-ink: #04170f;
      --green: #06b680;
      --green-soft: rgba(6, 182, 128, 0.14);
      --green-line: rgba(6, 182, 128, 0.42);
      --warn: #f5b544;
      --danger: #ef4444;
      --cyan: #38bdf8;
      --font: "Helvetica Neue", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --serif: "Songti SC", "Noto Serif SC", Georgia, serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }

    /* 顶栏 */
    header.deck-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 52px;
      padding: 0 24px;
      background: var(--bg-deep);
      border-bottom: 1px solid var(--line);
      z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark { width: 14px; height: 14px; background: var(--mint); box-shadow: 0 0 12px var(--mint); }
    .brand-title { font-size: 15px; font-weight: 700; letter-spacing: 0.12em; color: #FFF; font-family: var(--mono); }
    .brand-tag { font-size: 11px; padding: 2px 6px; background: var(--green-soft); color: var(--mint); border: 1px solid var(--green-line); }
    
    .nav-controls { display: flex; align-items: center; gap: 10px; }
    .counter { font-family: var(--mono); font-size: 13px; color: var(--muted); margin-right: 8px; }
    .btn {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px;
      background: var(--panel); border: 1px solid var(--line-strong); color: var(--text-2);
      font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; font-family: var(--font);
    }
    .btn:hover { border-color: var(--mint); color: var(--mint); }
    .btn.primary { background: var(--mint); color: var(--mint-ink); font-weight: 700; border-color: var(--mint); }
    .btn.primary:hover { background: #4dffb3; }

    /* 画布视口 */
    main.viewport {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      position: relative;
      background: radial-gradient(circle at 50% 30%, rgba(0, 255, 147, 0.05), transparent 70%);
    }
    .grid-bg {
      position: absolute; inset: 0; pointer-events: none;
      background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
      background-size: 54px 54px; opacity: 0.35;
    }
    .slide-wrapper {
      width: 1280px;
      height: 720px;
      background: var(--panel);
      border: 1px solid var(--line-strong);
      box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(0, 255, 147, 0.06);
      position: relative;
      overflow: hidden;
      display: flex;
    }

    /* 单页幻灯片 */
    .slide {
      position: absolute; inset: 0; display: none; padding: 40px 48px;
      flex-direction: column; background: var(--panel); overflow: hidden;
    }
    .slide.active { display: flex; animation: slideFade 0.2s ease-out; }
    @keyframes slideFade { from { opacity: 0; transform: scale(0.995); } to { opacity: 1; transform: scale(1); } }
    .slide-inner { display: flex; flex-direction: column; height: 100%; position: relative; }

    /* 通用版头 */
    .slide-top { margin-bottom: 14px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px;
      font: 600 11px/1 var(--mono); letter-spacing: 0.16em; color: var(--mint); margin-bottom: 8px;
    }
    .eyebrow .dot { width: 5px; height: 5px; background: var(--mint); box-shadow: 0 0 8px var(--mint); }
    .slide-header { display: flex; align-items: baseline; gap: 14px; }
    .slide-num { font-size: 26px; font-weight: 800; color: var(--mint); font-family: var(--mono); }
    .slide-header h2 { font-size: 25px; font-weight: 600; color: #FFF; letter-spacing: -0.01em; }
    .slide-sub { font-size: 13.5px; color: var(--text-2); margin-top: 4px; }

    /* Cover */
    .slide-cover { display: flex; flex-direction: column; justify-content: center; height: 100%; padding: 20px 20px; }
    .cover-title { font-size: 38px; font-weight: 700; color: #FFF; line-height: 1.25; margin-bottom: 12px; }
    .cover-subtitle { font-size: 17px; color: var(--mint); margin-bottom: 16px; font-weight: 500; }
    .cover-body { font-size: 13.5px; color: var(--muted); line-height: 1.8; margin-bottom: 24px; }

    /* Diagrams & Pipelines */
    .diagram-wrap { margin-bottom: 14px; }
    .mock-pipeline-bar {
      display: flex; align-items: center; gap: 8px; padding: 10px 16px;
      background: var(--bg-deep); border: 1px solid var(--line); font-size: 12px;
    }
    .pipe-step {
      display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
      border: 1px solid var(--line-strong); color: var(--muted); font-family: var(--mono);
    }
    .pipe-step.done { color: var(--green); border-color: var(--green-line); background: var(--green-soft); }
    .pipe-step.active { color: var(--mint-ink); background: var(--mint); border-color: var(--mint); font-weight: 700; }
    .pipe-arrow { color: var(--faint); font-weight: bold; }

    .diagram-cards-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 14px; }
    .diag-card { background: var(--raised); border: 1px solid var(--line); padding: 16px 14px; }
    .diag-card-h { font: 600 11px/1 var(--mono); color: var(--mint); margin-bottom: 8px; }
    .diag-card-title { font-size: 15px; font-weight: 600; color: #FFF; margin-bottom: 6px; }
    .diag-card-desc { font-size: 12px; color: var(--muted); line-height: 1.5; }

    /* Pain vs Solution Split */
    .diagram-split { display: grid; grid-template-columns: 1fr 40px 1fr; gap: 16px; }
    .diag-side { background: var(--raised); border: 1px solid var(--line); padding: 16px; }
    .diag-side.red { border-left: 3px solid var(--danger); }
    .diag-side.green { border-left: 3px solid var(--mint); }
    .diag-side-h { font-size: 13.5px; font-weight: 700; margin-bottom: 12px; }
    .diag-side.red .diag-side-h { color: #f87171; }
    .diag-side.green .diag-side-h { color: var(--mint); }
    .diag-node-list { display: flex; flex-direction: column; gap: 8px; }
    .diag-node { background: var(--panel); border: 1px solid var(--line); padding: 8px 12px; font-size: 12px; }
    .diag-node b { display: block; color: #FFF; margin-bottom: 2px; }
    .diag-node span { color: var(--muted); line-height: 1.4; }
    .diag-center-divider { display: flex; align-items: center; justify-content: center; }
    .chasm-tag { font-family: var(--mono); font-size: 11px; padding: 4px 6px; background: var(--line); color: var(--faint); }

    /* Architecture Topology */
    .arch-container { background: var(--bg-deep); border: 1px solid var(--line); padding: 16px; font-size: 12px; }
    .arch-layer-title { font-family: var(--mono); font-weight: 700; color: var(--mint); margin-bottom: 8px; }
    .arch-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .arch-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .arch-box { background: var(--raised); border: 1px solid var(--line-strong); padding: 8px 10px; color: var(--text-2); text-align: center; }
    .arch-arrow-down { text-align: center; font-family: var(--mono); color: var(--mint); margin: 8px 0; font-size: 11px; letter-spacing: 0.05em; }
    .arch-split-bottom { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 10px; }
    .arch-col { background: var(--raised); border: 1px solid var(--line); padding: 10px; }
    .arch-col-title { font-weight: 700; color: var(--cyan); margin-bottom: 6px; font-size: 12px; }
    .arch-sub-box { background: var(--panel); border: 1px solid var(--line); padding: 6px 8px; margin-bottom: 4px; color: var(--muted); font-size: 11px; }

    /* Horizontal Flow Steps */
    .flow-steps-horizontal { display: flex; align-items: center; justify-content: space-between; background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; }
    .flow-step { flex: 1; display: flex; align-items: center; gap: 8px; }
    .flow-step-num { font-family: var(--mono); font-weight: 700; font-size: 14px; color: var(--muted); }
    .flow-step.active .flow-step-num { color: var(--mint); }
    .flow-step.warn .flow-step-num { color: var(--warn); }
    .flow-step.highlight .flow-step-num { color: var(--cyan); }
    .flow-step-body b { display: block; font-size: 12px; color: #FFF; }
    .flow-step-body span { font-size: 11px; color: var(--muted); }
    .flow-arrow { color: var(--line-strong); padding: 0 8px; }

    /* MPR Flow */
    .mpr-flow-box { display: grid; grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr; gap: 8px; align-items: center; background: var(--raised); border: 1px solid var(--line); padding: 10px 14px; font-size: 11.5px; }
    .mpr-flow-step { background: var(--panel); border: 1px solid var(--line); padding: 8px 10px; }
    .mpr-flow-step b { display: block; color: var(--mint); margin-bottom: 2px; }
    .mpr-flow-step.highlight b { color: var(--cyan); }
    .mpr-flow-arrow { color: var(--mint); font-family: var(--mono); }

    /* Pipeline block flow */
    .pipeline-block-flow { display: flex; align-items: center; gap: 8px; background: var(--raised); border: 1px solid var(--line); padding: 10px 14px; }
    .p-block { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 8px 10px; }
    .p-badge { font-family: var(--mono); font-size: 10px; color: var(--mint); display: block; margin-bottom: 2px; }
    .p-block b { font-size: 12px; color: #FFF; display: block; margin-bottom: 2px; }
    .p-block span { font-size: 11px; color: var(--muted); }
    .p-arrow { color: var(--faint); }

    /* Diff Schema */
    .diff-schema-grid { display: flex; align-items: center; gap: 12px; background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; font-size: 12px; }
    .diff-item { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 8px 12px; }
    .diff-item.result { flex: 1.6; border-color: var(--green-line); }
    .diff-item b { display: block; color: #FFF; margin-bottom: 4px; }
    .diff-item span { font-size: 11px; color: var(--muted); line-height: 1.5; }
    .diff-math { font-family: var(--mono); color: var(--mint); font-weight: 700; }

    /* Sarcopenia flow */
    .sarco-step-flow { display: flex; align-items: center; gap: 8px; background: var(--raised); border: 1px solid var(--line); padding: 10px 14px; }
    .s-step { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 8px 10px; }
    .s-step b { display: block; font-size: 12px; color: var(--mint); margin-bottom: 2px; }
    .s-step.alert b { color: var(--warn); }
    .s-step span { font-size: 11px; color: var(--muted); }
    .s-arrow { color: var(--faint); }

    /* Consort Visual */
    .consort-visual-box { background: var(--raised); border: 1px solid var(--line); padding: 12px 18px; font-size: 12px; }
    .consort-node { background: var(--panel); border: 1px solid var(--line-strong); padding: 8px 12px; text-align: center; }
    .consort-node.top { border-color: var(--cyan); }
    .consort-node.bottom { border-color: var(--mint); }
    .consort-node b { display: block; color: #FFF; }
    .consort-node span { font-family: var(--mono); color: var(--mint); font-size: 11px; }
    .consort-branch { display: flex; align-items: center; justify-content: space-between; margin: 8px 0; }
    .consort-line-down { width: 2px; height: 30px; background: var(--line-strong); margin: 0 auto; }
    .consort-node-excl { background: #1a0f0f; border: 1px solid #7f1d1d; padding: 6px 12px; font-size: 11px; color: #fca5a5; max-width: 450px; margin-left: auto; }
    .consort-node-excl b { color: #f87171; }
    .consort-node-excl ul { margin: 4px 0 0 16px; padding: 0; }

    /* Table 1 Flow */
    .table1-flow-row { display: flex; align-items: center; gap: 12px; background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; font-size: 12px; }
    .t1-step { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 10px; }
    .t1-step b { display: block; color: var(--mint); margin-bottom: 4px; }
    .t1-step span { font-size: 11px; color: var(--muted); line-height: 1.4; display: block; }
    .t1-arrow { color: var(--faint); font-weight: 700; }

    /* Causal Survival Split */
    .causal-split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .cs-box { background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; font-size: 12px; }
    .cs-title { font-weight: 700; color: var(--mint); margin-bottom: 8px; font-size: 13px; }
    .cs-content b { color: #FFF; font-size: 12px; }
    .cs-content span { color: var(--muted); }

    /* PubMed Guard Flow */
    .guard-flow-container { background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; }
    .guard-flow-container .g-step { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 8px 10px; }
    .g-num { font-family: var(--mono); font-size: 10px; color: var(--mint); display: block; }
    .g-step b { display: block; color: #FFF; font-size: 12px; margin-bottom: 2px; }
    .g-step span { font-size: 11px; color: var(--muted); }
    .g-arrow { color: var(--faint); }
    .guard-mock-diff { margin-top: 10px; background: #fff; color: #1b1f1d; padding: 10px 14px; font: 12.5px/1.7 var(--serif); border: 1px solid var(--line); }
    .diff-title { font: 700 11px var(--mono); color: #06110d; margin-bottom: 4px; }
    .diff-del { color: #c0392b; text-decoration: line-through; }
    .diff-ins { background: rgba(6, 182, 128, 0.18); border-bottom: 1.5px solid var(--green); color: #047857; font-weight: 600; }
    .diff-badge-ok { display: inline-block; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; padding: 2px 6px; font: 700 10.5px var(--mono); margin-left: 8px; }

    /* Dual Mode */
    .dual-mode-grid { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--raised); border: 1px solid var(--line); padding: 12px 16px; font-size: 12px; }
    .dm-card { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 10px 12px; text-align: center; }
    .dm-h { font-weight: 700; color: #FFF; margin-bottom: 4px; }
    .dm-card span { font-size: 11px; color: var(--muted); }
    .dm-sync { text-align: center; font-family: var(--mono); font-size: 11px; color: var(--mint); padding: 0 10px; }
    .sync-icon { font-size: 18px; display: block; font-family: monospace; }
    .memory-engine-bar { margin-top: 10px; background: var(--bg-deep); border: 1px solid var(--line); padding: 8px 12px; font-size: 12px; }
    .memory-engine-bar b { color: var(--mint); }
    .memory-engine-bar span { color: var(--text-2); }

    /* Flywheel */
    .flywheel-flow { display: flex; align-items: center; gap: 8px; background: var(--raised); border: 1px solid var(--line); padding: 12px 14px; }
    .fw-node { flex: 1; background: var(--panel); border: 1px solid var(--line); padding: 8px 10px; text-align: center; font-size: 12px; font-weight: 700; color: #FFF; }
    .fw-node.active { border-color: var(--mint); color: var(--mint); }
    .fw-node.highlight { border-color: var(--cyan); color: var(--cyan); }
    .fw-node span { font-weight: normal; font-size: 10.5px; color: var(--muted); display: block; margin-top: 2px; }
    .fw-arrow { color: var(--faint); font-weight: 700; }

    /* Comparison Radar Badges */
    .radar-badges-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
    .r-badge { background: var(--raised); border: 1px solid var(--line-strong); padding: 8px 10px; font-size: 11.5px; font-weight: 600; text-align: center; }
    .r-badge.mint { border-color: var(--mint); color: var(--mint); }
    .r-badge.cyan { border-color: var(--cyan); color: var(--cyan); }
    .r-badge.green { border-color: var(--green); color: #34d399; }
    .r-badge.yellow { border-color: var(--warn); color: var(--warn); }

    /* Roadmap Grid */
    .roadmap-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
    .rm-phases { display: flex; flex-direction: column; gap: 6px; }
    .rm-p { background: var(--raised); border: 1px solid var(--line); padding: 8px 12px; font-size: 11.5px; color: var(--muted); }
    .rm-p.done { border-left: 3px solid var(--green); }
    .rm-p.done b { color: #34d399; }
    .rm-p.active { border-left: 3px solid var(--mint); color: var(--text-2); }
    .rm-p.active b { color: var(--mint); }
    .rm-airgap { background: var(--bg-deep); border: 1px solid var(--line-strong); padding: 14px; display: flex; flex-direction: column; justify-content: center; }
    .airgap-title { font-weight: 700; color: var(--cyan); margin-bottom: 8px; font-size: 13px; }
    .airgap-box { font-size: 12px; color: var(--text-2); line-height: 1.6; }

    /* Two-col grid */
    .two-col-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; flex: 1; overflow: hidden; }
    .col-panel { background: var(--raised); border: 1px solid var(--line); padding: 16px 20px; font-size: 13px; line-height: 1.65; overflow-y: auto; }
    .col-panel.red-border { border-left: 3px solid var(--danger); }
    .col-panel.green-border { border-left: 3px solid var(--mint); }
    .col-panel h3 { font-size: 14px; margin-bottom: 10px; color: #FFF; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
    .col-panel ul { padding-left: 18px; }
    .col-panel li { margin-bottom: 8px; }

    /* Image text grid */
    .img-text-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 24px; flex: 1; align-items: center; overflow: hidden; }
    .img-panel { background: #000; border: 1px solid var(--line-strong); border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; }
    .mock-window-bar { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; background: #0c1712; border-bottom: 1px solid var(--line); }
    .win-dot { width: 7px; height: 7px; border-radius: 50%; }
    .win-dot.red { background: #ef4444; }
    .win-dot.yellow { background: #f59e0b; }
    .win-dot.green { background: #10b981; }
    .win-title { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-left: 8px; }
    .slide-screenshot { width: 100%; max-height: 330px; object-fit: contain; display: block; }
    .img-meta { font-size: 11px; color: var(--muted); padding: 6px 10px; background: #050a08; border-top: 1px solid var(--line); font-family: var(--mono); }
    .text-panel { font-size: 13px; line-height: 1.7; overflow-y: auto; max-height: 380px; padding-right: 8px; }
    .text-panel ul { padding-left: 18px; }
    .text-panel li { margin-bottom: 8px; }

    /* Content & Table */
    .content-panel { font-size: 13px; line-height: 1.6; overflow-y: auto; flex: 1; }
    .content-panel table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11.5px; }
    .content-panel th { background: var(--bg-deep); color: var(--mint); padding: 8px 10px; text-align: left; border: 1px solid var(--line-strong); font-weight: 600; font-family: var(--mono); }
    .content-panel td { padding: 6px 10px; border: 1px solid var(--line); color: var(--text-2); }
    .content-panel tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
    .content-panel tr:hover { background: rgba(0, 255, 147, 0.04); }

    .diag-focused-desc { font-size: 13px; color: var(--text-2); line-height: 1.6; margin-top: 10px; }

    /* Closing */
    .slide-closing { display: flex; flex-direction: column; justify-content: center; height: 100%; padding: 20px; }
    .slide-closing h2 { font-size: 32px; color: #FFF; margin-bottom: 8px; }
    .closing-desc { font-size: 13.5px; line-height: 1.7; color: var(--muted); margin-top: 12px; }

    /* Speaker Notes Drawer */
    .speaker-notes {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: rgba(13, 29, 23, 0.95); border-top: 1px solid var(--green-line);
      padding: 10px 20px; font-size: 12px; color: #6ee7b7; line-height: 1.5;
      display: none; backdrop-filter: blur(8px);
    }
    body.show-notes .speaker-notes { display: block; }

    /* 底部条 */
    footer.deck-foot {
      height: 38px; background: var(--bg-deep); border-top: 1px solid var(--line);
      display: flex; align-items: center; justify-content: space-between; padding: 0 24px;
      font-size: 11.5px; color: var(--muted); font-family: var(--mono);
    }
  </style>
</head>
<body>
  <header class="deck-bar">
    <div class="brand">
      <div class="brand-mark"></div>
      <div class="brand-title">HEURION 2.0</div>
      <span class="brand-tag">CLINICAL AI WORKSTATION</span>
    </div>
    <div class="nav-controls">
      <span class="counter" id="slideCounter">1 / ${SLIDES.length}</span>
      <button class="btn" id="btnPrev" title="上一页 (&lt;-)">上一页</button>
      <button class="btn" id="btnNext" title="下一页 (-&gt;)">下一页</button>
      <button class="btn" id="btnNotes" title="讲者剧本开关 (N)">讲者剧本 (N)</button>
      <button class="btn primary" id="btnFs" title="全屏演示 (F)">全屏演示 (F)</button>
    </div>
  </header>

  <main class="viewport">
    <div class="grid-bg"></div>
    <div class="slide-wrapper" id="slideWrapper">
      ${slidesHtml}
    </div>
  </main>

  <footer class="deck-foot">
    <div>快捷键：<b>&lt;- / -&gt;</b> 翻页 | <b>F</b> 全屏 | <b>N</b> 讲者剧本 | <b>Home/End</b> 首页/末页</div>
    <div>MANTLE DESIGN SYSTEM · HTTPS://HEURION.ORG</div>
  </footer>

  <script>
    let cur = 0;
    const total = ${SLIDES.length};
    const slides = document.querySelectorAll('.slide');
    const counter = document.getElementById('slideCounter');

    function show(i) {
      if (i < 0) i = 0;
      if (i >= total) i = total - 1;
      slides[cur].classList.remove('active');
      cur = i;
      slides[cur].classList.add('active');
      counter.textContent = (cur + 1) + ' / ' + total;
      location.hash = 'slide-' + (cur + 1);
    }

    document.getElementById('btnPrev').addEventListener('click', () => show(cur - 1));
    document.getElementById('btnNext').addEventListener('click', () => show(cur + 1));
    
    const notesBtn = document.getElementById('btnNotes');
    notesBtn.addEventListener('click', () => {
      document.body.classList.toggle('show-notes');
      notesBtn.classList.toggle('primary');
    });

    const fsBtn = document.getElementById('btnFs');
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
    });

    window.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') show(cur + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(cur - 1);
      else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(total - 1);
      else if (e.key === 'n' || e.key === 'N') notesBtn.click();
      else if (e.key === 'f' || e.key === 'F') fsBtn.click();
    });

    const hash = location.hash;
    if (hash && hash.startsWith('#slide-')) {
      const p = parseInt(hash.replace('#slide-', ''), 10);
      if (!isNaN(p)) show(p - 1);
      else show(0);
    } else {
      show(0);
    }
  </script>
</body>
</html>`;

  function renderMarkdown(md: string): string {
    return md
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^- (.*$)/gim, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gms, '<ul>$1</ul>')
      .replace(/<\/ul>\s*<ul>/g, '')
      .replace(/\n\n/g, '<br>');
  }

  const htmlPath = path.join(WORKSPACE_DIR, 'heurion_demo_deck.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`HTML Presentation generated successfully: ${htmlPath} (${Buffer.byteLength(html)} bytes)`);
  return htmlPath;
}

async function main() {
  console.log('=== Starting Heurion 2.0 Mantle-Themed Demo Deck Generation (Zero Emoji) ===');
  const pptxFile = await generatePptx();
  const htmlFile = await generateHtmlPresentation();
  console.log('=== Generation Finished ===');
  console.log('PPTX Deck File:', pptxFile);
  console.log('Interactive HTML Deck File:', htmlFile);
}

main().catch(err => {
  console.error('Error generating demo deck:', err);
  process.exit(1);
});
