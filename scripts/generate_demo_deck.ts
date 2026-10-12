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

const SLIDES: SlideData[] = [
  {
    title: '临床科研，从数据沉淀到成果发表的全流程工作台',
    subtitle: '下一代 AI 原生临床科研智能工作台与医学协作操作系统 (Clinical Research AI Workstation)',
    layout: 'cover',
    category: 'OVERVIEW - 平台总览',
    body: '汇报人：Heurion 联合研发与医学科研团队 | 医学智能研究中心\n官方主页：https://heurion.org | 工作台入口：https://heurion.org/app\n底层引擎：@heurion2/platform + apps/imaging-worker (MONAI / PyTorch)',
    diagramKey: 'cover_pipeline',
    notes: '开场引入：介绍 Heurion 2.0 作为专为临床科学家打造的一体化工作台，贯通从患者入组纳排、3D 影像量化、隔离沙箱统计，到发表级 Table 1 与 PubMed 验真的全生命周期。'
  },
  {
    title: '为什么通用 AI 无法支撑严肃临床科研？卡在四个关键环节',
    subtitle: '通用 LLM (ChatGPT / Claude) 缺乏医学专用基础设施，存在四大致命阻碍',
    layout: 'two_col',
    category: 'CHALLENGE - 行业痛点',
    body: '### 通用大模型的四大致命短板\n- **1. 数据孤岛与隐私失控**：公有大模型云端传输存在 PHI 违规风险，缺乏去标识化机制\n- **2. 队列圈定与分析断层**：无法关联多表 EMR 库，不能进行 3D 体素级医学运算与统计\n- **3. 课题记忆断代**：单次对话窗口用尽后，研究假设、纳排口径与分期标准全被遗忘\n- **4. 引用凭空捏造与改动黑盒**：幻觉虚构假 PMID/DOI，全篇覆写抹杀医生既有论述',
    body2: '### Heurion 2.0 的专业破局解法\n- **1. Zero-PHI 本地隔离沙箱**：正则与 NLP 拦截 18 位身份证与病案号，受试者学术编码 S001...\n- **2. 数据库级动态纳排**：秒级交并筛选，自动生成符合 CONSORT 2010 标准的矢量流程图\n- **3. 课题级自主记忆演进**：持续沉淀 8 类核心知识，人机协同越用越准\n- **4. NCBI PubMed 实时交叉验真**：直连官方接口校验效应量，行内红绿 Diff 与写前守卫',
    diagramKey: 'pain_vs_solution',
    notes: '强调走访数十家三甲医院的真实反馈：临床医生需要的是零泄露风险、有真实体素计算、不造假文献的专业科研工作台。'
  },
  {
    title: '双服务解耦架构与高可信医学智能底座',
    subtitle: '微服务解耦、无网络隔离计算沙箱、MONAI 影像微服务与纯 Rust 4K 光栅化',
    layout: 'diagram_focused',
    category: 'ARCHITECTURE - 系统架构',
    body: '- **@heurion2/platform (:8787)**：承载 Hono REST API、Yjs CRDT 毫秒协同网关、多租户隔离与 PubMed 验真引擎\n- **apps/imaging-worker (:8004)**：Project MONAI + PyTorch 物理体素运算环境，部署 19 类真实本地权重模型\n- **无网络隔离沙箱 (apps/platform/src/harness)**：Linux/macOS 独立 UID 运行 Python/R 环境，执行统计运算与原生 Word 导出\n- **自闭环光栅化 (@resvg/resvg-js)**：纯 Rust WASM 引擎，无需 LibreOffice 依赖，秒级将矢量幻灯片渲染为 4K 高保真图像',
    diagramKey: 'system_architecture',
    notes: '展示技术选型的硬核优势：Monorepo 解耦、Yjs CRDT 毫秒协同、纯 Rust 4K 渲染、以及无网安全隔离沙箱。'
  },
  {
    title: '患者数据资产化：多模态 OCR 建档与因果时间轴 (PHR)',
    subtitle: '门诊化验单、出院小结结构化提取，24 个月纵向追踪与加密授权共享',
    layout: 'image_text',
    category: 'DATA ASSET - 患者档案',
    image: 'real-case-5-diagnostic-chain.png',
    body: '- **多模态 OCR 结构化提取**：手机拍照化验单、出院小结扫描件秒级识别指标数值与参考区间（如总 IgE 1250 kU/L）\n- **纵向时间轴趋势对齐**：跨周期复查数据自动对齐，点击化验项目即刻展现 24 个月动态折线图\n- **知家 (PHR) 空间与加密 Claims 共享**：基于限时限范围口令（PhrClaim），患者扫码将就诊数据安全注入课题池\n- **全链路 Zero-PHI 隐私防线**：18 位身份证、电话与病案号自动脱敏，从源头杜绝临床隐私泄露风险',
    diagramKey: 'data_ingestion_flow',
    notes: '现场演示展示 PT-CHEST-001 患者因果诊断链，总 IgE 1250kU/L 与 CT 粘液栓的结合。'
  },
  {
    title: 'MONAI 3D 体素医学影像量化与三正交切片联动 (MPR)',
    subtitle: '真 3D 物理体素空间计算，颠覆 2D 截图粗糙估算，实现亚毫米级精准测量',
    layout: 'image_text',
    category: 'IMAGING AI - 3D 影像量化',
    image: 'real-case-2-mpr-3view.png',
    body: '- **物理体素空间真 3D 计算**：自动解析 DICOM Slice Thickness 与 Spacing，杜绝屏幕像素误判\n- **MPR 三正交切片毫秒级联动**：Axial、Coronal、Sagittal 十字交叉准星拖拽，三维解剖实时响应\n- **预设标准化亨氏单位 (HU) 窗宽窗位**：\n  - 肺窗 (-600 / 1500 HU)、纵隔窗 (40 / 400 HU)\n  - 腹部软组织窗 (40 / 350 HU)、骨窗 (300 / 1500 HU)\n- **19 类真实本地权重部署**：单卷 CT 脾脏体积测定平均推理时间 < 1.2 秒',
    diagramKey: 'mpr_coordinate_diagram',
    notes: '演示 3D MPR 阅片器，展示三视图十字准星亚毫米级拖拽联动。'
  },
  {
    title: '实体瘤 RECIST 1.1 自动评估与 3D 影像组学 (Radiomics)',
    subtitle: '肿瘤最大横截面自动寻优、长短轴测量、三维容积积分与 IBSI 特征提取',
    layout: 'image_text',
    category: 'RECIST 1.1 - 实体瘤评估',
    image: 'real-case-nsclc-1-baseline-recist.png',
    body: '- **RECIST 1.1 靶病灶三维标定**：\n  - 算法自动定位肿瘤最大横截面中心层 (Key Slice，如第 138 层)\n  - 自动拟合最大长径 (Long Axis: 48.2mm) 与垂直短轴 (Short Axis: 32.6mm)\n  - 3D 实体瘤容积精确积分 (Volume: 34.8 cm³)\n- **IBSI 国际标准影像组学 (Radiomics)**：\n  - 提取球形度、表面积体积比、灰度非均匀性 GLCM / GLRLM 共 107 项特征\n- **结构化放射学报告一键归档**：直接作为科研变量并入后续统计宽表',
    diagramKey: 'recist_pipeline_diagram',
    notes: '展示奥希替尼晚期非小细胞肺癌患者基线 CT 的 RECIST 标定。'
  },
  {
    title: '双期三维刚性配准与差分吸收热力图 (Diff Heatmap)',
    subtitle: '红绿双色直观展示肿瘤退缩（Regression）与进展（Progression），RECIST 智能裁决',
    layout: 'image_text',
    category: 'FOLLOW-UP - 随访差分',
    image: 'real-case-nsclc-3-diff-heatmap.png',
    body: '- **3D 刚性空间互信息配准**：消除基线与复查 CT 呼吸体位导致的切片不对齐\n- **体素级差分吸收热力图 (Diff Heatmap)**：\n  - 绿色冷色调区域：HU 显著下降与吸收坏死，代表肿瘤退缩 (Regression, 体积缩小 58.3%)\n  - 红色暖色调区域：HU 升高与浸润进展 (Progression)\n- **RECIST 疗效智能判定**：长径缩小 > 30%，判定为部分缓解 (PR)\n- **双屏联动同步阅片**：左右分屏滚动，自动对齐同一解剖结构',
    diagramKey: 'diff_heatmap_diagram',
    notes: '红绿差分图极其具有视觉冲击力，突出奥希替尼治疗 3 个月后的肿瘤坏死吸收。'
  },
  {
    title: '全身 104 类全器官分割与 L3 骨骼肌指数 (SMI)',
    subtitle: '挖掘 CT 平扫潜藏的营养、代谢与化疗药物毒性预警生物标志物',
    layout: 'image_text',
    category: 'SARCOPENIA - 肌少症量化',
    image: 'real-case-4-l3-smi.png',
    body: '- **自动定位 L3 椎体中点切片**：杜绝人工选层的观察者间误差\n- **骨骼肌与脂肪分层密度量化**：\n  - 骨骼肌截面积 (SMA, -29~+150 HU): 98.4 cm²\n  - 骨骼肌指数 (SMI = SMA / 身高²): 34.2 cm²/m² (严重隐匿性肌少症预警)\n  - 内脏脂肪 (VAT) 与皮下脂肪 (SAT) 面积比自动测定\n- **药代动力学 (PK) 与化疗毒性预警**：\n  - 关联化疗药物清除率下调，提示 3 级以上严重不良事件发生率增加 2.8 倍',
    diagramKey: 'sarcopenia_diagram',
    notes: '展示平扫 CT 挖掘隐匿性肌少症生物标志物的临床与科研双重价值。'
  },
  {
    title: '多维受试者圈定与 CONSORT 2010 矢量流程图',
    layout: 'image_text',
    category: 'COHORT - 课题纳排',
    image: 'real-case-research-1-protocol-cohort.png',
    body: '- **PICO 框架驱动的多维纳排引擎**：\n  - 支持 ICD 编码、用药、年龄/性别、检验区间 (eGFR, NT-proBNP) 及影像指标 (LVEF <= 40%) 的复杂交并集\n- **学术受试者去标识化追踪 (S001...S1420)**：\n  - 自动解耦临床病案号，生成唯一科研代号，符合伦理审查\n- **CONSORT 2010 / STROBE 矢量图秒级生成**：\n  - 记录初始筛查人数 (N=2,150) 与各项具体排除原因与人数 (排除 730 例)\n  - 导出高清 SVG 与 Mermaid 矢量图，直接插入论文 Methods',
    diagramKey: 'consort_flow_diagram',
    notes: '展示心衰队列入组纳排流程，强调严格记录排除原因对顶刊投稿的关键意义。'
  },
  {
    title: '发表级 Table 1 原生 Word (.docx) 三线表导出',
    subtitle: '告别手工制表复制粘贴，严格符合 NEJM / Lancet 顶刊三线表排版规范',
    layout: 'image_text',
    category: 'EVIDENCE - 原生三线表',
    image: 'real-case-research-2-table1-baseline.png',
    body: '- **真原生 Word 格式 (Native OpenXML .docx)**：\n  - 严格顶底 1.5pt、栏目线 0.5pt，宋体 / Times New Roman 排版\n- **智能统计学检验方法自适应**：\n  - 正态连续变量: Mean ± SD (Student\'s t-test)\n  - 偏态连续变量: Median [IQR] (Mann-Whitney U 检验)\n  - 分类变量: n (%)，频数 < 5 自动采用 Fisher 精确检验，否则卡方检验\n- **倾向评分匹配 (PSM) 与绝对 SMD 平衡**：\n  - 匹配后标准化均数差 SMD < 0.05，基线协变量完全均衡',
    diagramKey: 'table1_pipeline_diagram',
    notes: '现场双击打开下载的 Word 文件，展示完全免手工二次排版的震撼效果。'
  },
  {
    title: '因果推断、Kaplan-Meier 生存分析与预测模型',
    subtitle: '在隔离沙箱内秒级运行 Python/R 高级统计学算子，完成审稿人混杂敏感度抗辩',
    layout: 'two_col',
    category: 'STATISTICS - 因果与生存分析',
    body: '### 因果推断与混杂偏倚控制\n- **Love Plot 绝对 SMD 均衡图**：匹配后散点全部收敛至 SMD < 0.1 警戒线内\n- **VanderWeele E-value 未测混杂敏感度抗辩**：\n  - 计算得 E-value = 2.45 (CI 1.76)\n  - 自动输出中英双语顶刊审稿人抗辩陈述：“需存在 RR >= 2.45 的未测混杂才可能推翻当前结论”',
    body2: '### 生存分析与 TRIPOD 预测模型\n- **Kaplan-Meier 累积无事件生存曲线**：\n  - 24 个月 MACE 事件曲线，带风险人数表，Log-rank P < 0.001\n- **多因素 Cox 比例风险回归森林图**：\n  - 达格列净暴露 HR 0.74 (95% CI 0.65-0.85)\n- **TRIPOD 规范临床预测模型**：\n  - LASSO 特征降维、Logistic 回归、ROC 曲线 (AUC)、校准曲线与决策曲线分析 (DCA)',
    diagramKey: 'causal_survival_diagram',
    notes: '展示高级统计沙箱能力，包括 KM 曲线与审稿人最关注的 E-value 混杂抗辩。'
  },
  {
    title: '严肃学术引证防伪：PubMed 实时核验与写前守卫',
    subtitle: '直连 NCBI 官方数据库逐字核验效应量，彻底杜绝 AI 虚构伪文献',
    layout: 'diagram_focused',
    category: 'GROUNDING - 学术验真',
    body: '### 三重防护坚守医学科研真实性底线\n- **1. NCBI PubMed / Europe PMC / OpenAlex 直连交叉核验**：\n  - 论文引用的每一篇参考文献必须绑定官方真实 PMID 与 DOI\n- **2. 细粒度命题级论断核查 (verify_claims)**：\n  - 抽取正文效应量数据（HR 0.74, 95% CI 0.65-0.85），直连 PubMed XML 全文校验，标记支持状态\n- **3. 写前守卫 (Write Guards) 与人类优先权**：\n  - AI 提议的文字通过行内红绿 Diff (Character-level Diff) 呈现，保留医生核心观点\n  - 评论锚点长效保全，人类批注在 AI 修订后依然吸附精准',
    diagramKey: 'pubmed_guard_diagram',
    notes: '强调顶刊投稿绝不能出现假文献，Heurion 采用底层拦截技术彻底消除幻觉风险。'
  },
  {
    title: '文档与演示文稿一体化双模协同与课题记忆演进',
    subtitle: '同一套科研数据底座，同步产出 IMRAD 论文手稿与 16:9 学术答辩幻灯片',
    layout: 'two_col',
    category: 'WORKSPACE - 双模协同',
    body: '### Docs & Slides 双模协同设计器\n- **形态一键平滑切换**：\n  - 课题内容既可作为 IMRAD 论文长文排版，亦可一键转为 16:9 学术汇报幻灯片\n- **8 种学术标准版式与医院定制主题**：\n  - 封面、两栏、图文、大数字、致谢\n  - 三甲医院定制专属院徽水印与科室色谱\n- **纯 Rust WASM 渲染器**：秒级输出 4K 高清幻灯片',
    body2: '### 课题级自主记忆演进系统\n- **机器在环 (Machine-in-the-loop) 动态沉淀**：\n  - 深度观察研究者的每次修订、确认与选择\n  - 沉淀 8 类核心知识：研究假设、诊断口径、排除标准细节、特定亚组偏好\n- **去伪存真与自我淘汰**：\n  - 自动识别过期口径并退役，杜绝传统 Agent 记忆发散膨胀',
    diagramKey: 'dual_mode_memory_diagram',
    notes: '展示双模一体设计，同一份科研数据底座，既出学术论文，又出答辩 PPT。'
  },
  {
    title: '端到端实战标杆：DAPA-HF 心衰多中心研究闭环',
    subtitle: '从万级患者库到 NEJM 级别论文与汇报材料的一站式飞轮闭环',
    layout: 'image_text',
    category: 'BENCHMARK - 标杆闭环',
    image: 'real-case-research-5-research-loop.png',
    body: '- **1. PICO 方案圈定**：从 2,150 例门诊档案中筛选 1,420 例达标受试者 (S001~S1420)\n- **2. 3D 影像匹配**：提取心脏超声与腹部 CT 参数，对齐 24 个月生化指标\n- **3. 倾向评分匹配**：1:1 PSM 匹配，一键生成符合顶刊规范的 Table 1 原生 Word 三线表\n- **4. 沙箱高级统计**：24 个月 KM 曲线 (P<0.001)、Cox 回归森林图 (HR 0.74)、E-value 混杂抗辩 (2.45)\n- **5. 成果双模生成**：PubMed 验真支持下一键输出 SCI 投稿草稿与答辩幻灯片',
    diagramKey: 'dapa_hf_flywheel',
    notes: '串联全流程飞轮，展示从原始数据到高质量论文生成的完整闭环。'
  },
  {
    title: '为什么临床医学科研，需要专用智能工作台？',
    subtitle: '七大核心维度全面超越通用大模型与传统单点工具 (SPSS / Excel / PACS)',
    layout: 'content',
    category: 'COMPARISON - 竞品对比',
    body: `### 七大核心维度横向测评对比

| 评估维度 | Heurion 2.0 临床科研工作台 | 通用大模型 (ChatGPT / Claude) | 传统单点工具 (SPSS / Excel / PACS) |
| :--- | :--- | :--- | :--- |
| **文献真实性校验** | **直连 PubMed/EuropePMC 交叉核验，假引注 100% 拦截** | 存在严重“幻觉”，虚构不存在的 DOI/PMID | 纯手工逐篇检索查验，耗费海量人工 |
| **3D 体素医学影像** | **原生集成 MONAI 3D、RECIST 1.1、MPR 切片联动与差分热力图** | 仅支持 2D 截图视见，无三维体素，物理尺寸误判 | 需额外安装独立庞大的离线 PACS，与科研脱节 |
| **隐私合规 Zero-PHI** | **独立无网络沙箱，S001... 学术去标识化，零公网留存** | 医疗数据上传至外部商业模型服务器，违规风险高 | 文件虽在本地，但缺乏自动化脱敏与加密共享 |
| **受试者多维纳排** | **秒级多表交并过滤，全自动生成 CONSORT 流程图** | 无法关联复杂多表，无法计算精确人群交并与剔除数 | 依赖手工在 Excel 写复杂公式或数据库写 SQL |
| **顶刊标准 Table 1** | **一键导出原生 Word (.docx) 1.5pt/0.5pt 三线表与检验脚注** | 仅能生成 Markdown 或 HTML，需人工繁琐排版 | 需手动将统计分析输出逐行复制粘帖至 Word |
| **严谨统计计算沙箱** | **内嵌 Linux/macOS 独立 UID 隔离 Python/R 计算环境** | 仅能输出 Python 代码段，无法在本地安全执行 | 需手动操作交互界面，各模块之间缺乏连续数据流 |
| **AI 智能体协同协议** | **原生标准化 Model Context Protocol (MCP)** | 仅支持通识 Chat，无医学科研专用工具箱 | 无 AI 接口与 Agent 扩展支持 |`,
    diagramKey: 'comparison_matrix_diagram',
    notes: '对比表格条理分明，直击各类竞品与替代方案的痛处。'
  },
  {
    title: '持续演进的临床科研智能基础设施',
    subtitle: '从单工作台单点突破，走向多中心联邦医学科研协作网络与合规私有化落地',
    layout: 'closing',
    category: 'ROADMAP - 演进与交付',
    body: '从单工作台单点突破，走向多中心联邦医学科研智能网络\n\n- **Phase 1 (已就绪)**：患者数据资产化、受试者纳排、MONAI 3D 量化、原生 Table 1 与 CONSORT\n- **Phase 2 (已就绪)**：Docs & Slides 双模协同、纯 Rust 4K 渲染、PubMed 交叉验真、MCP 生产级接入\n- **Phase 3 (推进中)**：科室多中心课题联邦协作网络、电子化知情同意书 (e-Consent) 与 eCRF 质控\n- **Phase 4 (前瞻布局)**：真实世界证据 (RWE) 主动发现与多模态虚拟患者队列 (Digital Twin Cohort)\n\n官方联系：support@heurion.org | 平台体验：https://heurion.org/app\n感谢各位专家与评委！欢迎交流提问。',
    diagramKey: 'roadmap_airgap_diagram',
    notes: '收尾展望：强调私有化 Airgap 部署能力，欢迎试用与合作。'
  }
];

// SVG Diagram Builders styled with Heurion Mantle dark/mint colors (#06110d, #08150f, #1e2925, #00ff93, #06b680, #0298fe, #f5b544)
// Pure technical style: NO EMOJI
const DIAGRAMS: Record<string, string> = {
  cover_pipeline: `
    <div class="diagram-wrap">
      <div class="mock-pipeline-bar">
        <span class="pipe-step done">阶段 1: 患者健康档案 (PHR & 多模态 OCR) [完成]</span>
        <span class="pipe-arrow">-&gt;</span>
        <span class="pipe-step done">阶段 2: 受试者纳排与 MONAI 3D 量化 (S001...) [完成]</span>
        <span class="pipe-arrow">-&gt;</span>
        <span class="pipe-step done">阶段 3: 课题记忆演进 (8条结论) [完成]</span>
        <span class="pipe-arrow">-&gt;</span>
        <span class="pipe-step active">阶段 4: 发表级 Table 1 三线表与证据链</span>
      </div>
      <div class="diagram-cards-row">
        <div class="diag-card">
          <div class="diag-card-h">模块 01 / 数据汇聚</div>
          <div class="diag-card-title">化验单 OCR & PHR</div>
          <div class="diag-card-desc">门诊住院病历秒级数字化，时间轴纵向追踪</div>
        </div>
        <div class="diag-card">
          <div class="diag-card-h">模块 02 / 空间计算</div>
          <div class="diag-card-title">MONAI 3D & MPR</div>
          <div class="diag-card-desc">19 类深度学习权重，实体瘤 RECIST 1.1 自动标定</div>
        </div>
        <div class="diag-card">
          <div class="diag-card-h">模块 03 / 隔离统计</div>
          <div class="diag-card-title">无网沙箱 Python/R</div>
          <div class="diag-card-desc">原生 Word 三线表，KM 曲线与 E-value 敏感度抗辩</div>
        </div>
        <div class="diag-card">
          <div class="diag-card-h">模块 04 / 顶刊发表</div>
          <div class="diag-card-title">PubMed 验真 & 双模</div>
          <div class="diag-card-desc">直连 NCBI 校验效应量，论文手稿与 16:9 幻灯片同步</div>
        </div>
      </div>
    </div>
  `,

  pain_vs_solution: `
    <div class="diagram-wrap">
      <div class="diagram-split">
        <div class="diag-side red">
          <div class="diag-side-h">[通用大模型四大致命软肋]</div>
          <div class="diag-node-list">
            <div class="diag-node red">
              <b>1. 数据孤岛与隐私失控</b>
              <span>公网 API 传输患者真实个人健康信息 (PHI)，严重违背临床伦理与 HIPAA 法规</span>
            </div>
            <div class="diag-node red">
              <b>2. 队列圈定与分析断层</b>
              <span>通用 Chat 界面无法直接穿透 EMR/LIS 多表关联，缺乏 3D 体素医学图像运算</span>
            </div>
            <div class="diag-node red">
              <b>3. 课题记忆断代与遗忘</b>
              <span>上下文窗口耗尽即丢失既定研究假设、排除口径与亚组划分，被迫反复交代</span>
            </div>
            <div class="diag-node red">
              <b>4. 引用凭空捏造与改动黑盒</b>
              <span>大模型“幻觉”虚构 fake PMID/DOI；全篇覆写抹杀医生深思熟虑的核心批注</span>
            </div>
          </div>
        </div>
        <div class="diag-center-divider">
          <span class="chasm-tag">VS</span>
        </div>
        <div class="diag-side green">
          <div class="diag-side-h">[Heurion 2.0 专用医学智能工作台解决方案]</div>
          <div class="diag-node-list">
            <div class="diag-node green">
              <b>1. Zero-PHI 本地隔离计算</b>
              <span>正则 + NLP 拦截 18 位身份证与病案号；受试者专属学术编号 (S001...S1420)</span>
            </div>
            <div class="diag-node green">
              <b>2. 数据库级动态纳排与 3D 量化</b>
              <span>秒级交并过滤，自动输出 CONSORT 2010 矢量流程图；原生 MONAI 3D 体素测量</span>
            </div>
            <div class="diag-node green">
              <b>3. 课题级自主记忆演进系统</b>
              <span>深度观察医生修订，沉淀 8 类核心知识；具备去伪存真与自我淘汰机制</span>
            </div>
            <div class="diag-node green">
              <b>4. NCBI PubMed 实时交叉验真</b>
              <span>直连 PubMed XML 逐字比对 HR/OR/95%CI；行内红绿差异比对与写前守卫拦截</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,

  system_architecture: `
    <div class="diagram-wrap">
      <div class="arch-container">
        <div class="arch-layer top">
          <div class="arch-layer-title">[1. 交互与呈现层] (Web Frontend - apps/platform/web)</div>
          <div class="arch-grid-3">
            <div class="arch-box">ProseMirror 医学文档协同画布 (IMRAD 规范)</div>
            <div class="arch-box">16:9 Deck 幻灯片设计器 (8类版式与主题)</div>
            <div class="arch-box">NiiVue WebGL2 3D 体绘制 + 2D MPR 阅片器</div>
          </div>
        </div>
        <div class="arch-arrow-down">| WebSocket (CRDT) & REST API 毫秒级双向通道 |</div>
        <div class="arch-layer mid">
          <div class="arch-layer-title">[2. 调度与业务中枢] (@heurion2/platform :8787)</div>
          <div class="arch-grid-4">
            <div class="arch-box">Hono 高性能 REST 服务</div>
            <div class="arch-box">Yjs CRDT 分布式无锁网关</div>
            <div class="arch-box">多租户隔离与 PhrClaim 授权</div>
            <div class="arch-box">PubMed / PMC / OpenAlex 验真</div>
          </div>
        </div>
        <div class="arch-split-bottom">
          <div class="arch-col left">
            <div class="arch-col-title">[3. 3D 影像微服务] (:8004)</div>
            <div class="arch-sub-box">Project MONAI & PyTorch (CUDA/MPS)</div>
            <div class="arch-sub-box">19 类深度学习权重 (RECIST 1.1 / TotalSegmentator)</div>
            <div class="arch-sub-box">3D MPR 切片提取 & 双期差分热力图</div>
          </div>
          <div class="arch-col center">
            <div class="arch-col-title">[4. 纯 Rust 光栅化引擎]</div>
            <div class="arch-sub-box">@resvg/resvg-js (WASM / Native)</div>
            <div class="arch-sub-box">秒级输出 4K 高保真幻灯片预览图</div>
            <div class="arch-sub-box">免安装 LibreOffice / 无头浏览器依赖</div>
          </div>
          <div class="arch-col right">
            <div class="arch-col-title">[5. 隔离计算沙箱] (Harness)</div>
            <div class="arch-sub-box">Linux/macOS 独立 UID 无外网沙箱</div>
            <div class="arch-sub-box">Python/R: lifelines, tableone, MatchIt</div>
            <div class="arch-sub-box">原生 Word (.docx) 顶刊三线表导出</div>
          </div>
        </div>
      </div>
    </div>
  `,

  data_ingestion_flow: `
    <div class="diagram-wrap">
      <div class="flow-steps-horizontal">
        <div class="flow-step">
          <div class="flow-step-num">01</div>
          <div class="flow-step-body">
            <b>多模态文件上传</b>
            <span>化验单、出院小结、检查单 (PDF/JPG/PNG)</span>
          </div>
        </div>
        <div class="flow-arrow">-&gt;</div>
        <div class="flow-step warn">
          <div class="flow-step-num">02</div>
          <div class="flow-step-body">
            <b>Zero-PHI 脱敏扫描</b>
            <span>正则/NLP 截断身份证号、病案号与电话</span>
          </div>
        </div>
        <div class="flow-arrow">-&gt;</div>
        <div class="flow-step active">
          <div class="flow-step-num">03</div>
          <div class="flow-step-body">
            <b>多模态 OCR 结构化</b>
            <span>自动解析检验项目、数值、参考区间与高低</span>
          </div>
        </div>
        <div class="flow-arrow">-&gt;</div>
        <div class="flow-step">
          <div class="flow-step-num">04</div>
          <div class="flow-step-body">
            <b>时间轴纵向数据库</b>
            <span>多期复查自动对齐，24 个月动态趋势折线图</span>
          </div>
        </div>
        <div class="flow-arrow">-&gt;</div>
        <div class="flow-step highlight">
          <div class="flow-step-num">05</div>
          <div class="flow-step-body">
            <b>因果诊断链沉淀</b>
            <span>总 IgE 异常 -&gt; CT 粘液栓 -&gt; ABPA 诊断</span>
          </div>
        </div>
      </div>
    </div>
  `,

  mpr_coordinate_diagram: `
    <div class="diagram-wrap">
      <div class="mpr-flow-box">
        <div class="mpr-flow-step">
          <b>步骤 1. DICOM 3D 体素阵列</b>
          <span>读取 Pixel Spacing 与 Slice Thickness，构建空间变换仿射矩阵</span>
        </div>
        <div class="mpr-flow-arrow">-&gt;</div>
        <div class="mpr-flow-step active">
          <b>步骤 2. MPR 三正交切片联动提取</b>
          <span>轴位 (Axial) / 冠状位 (Coronal) / 矢状位 (Sagittal) 十字准星亚毫米联动</span>
        </div>
        <div class="mpr-flow-arrow">-&gt;</div>
        <div class="mpr-flow-step">
          <b>步骤 3. 亨氏单位 (HU) 窗宽窗位映射</b>
          <span>肺窗 (-600/1500) | 纵隔窗 (40/400) | 腹部窗 (40/350) | 骨窗 (300/1500)</span>
        </div>
        <div class="mpr-flow-arrow">-&gt;</div>
        <div class="mpr-flow-step highlight">
          <b>步骤 4. MONAI 深度学习推理</b>
          <span>真 3D 体积积分计算（脾脏 680.4 cm³、肺结节容积），杜绝像素尺寸估算误判</span>
        </div>
      </div>
    </div>
  `,

  recist_pipeline_diagram: `
    <div class="diagram-wrap">
      <div class="pipeline-block-flow">
        <div class="p-block">
          <span class="p-badge">Step 1</span>
          <b>3D 肿瘤分割掩膜</b>
          <span>MONAI NSCLC 靶病灶分割与边缘高保真提取</span>
        </div>
        <div class="p-arrow">-&gt;</div>
        <div class="p-block">
          <span class="p-badge">Step 2</span>
          <b>Key Slice 关键层定位</b>
          <span>沿 Z 轴自动寻优横截面积最大的层面 (第 138 层)</span>
        </div>
        <div class="p-arrow">-&gt;</div>
        <div class="p-block active">
          <span class="p-badge">Step 3</span>
          <b>长短轴严格拟合</b>
          <span>最大长径: 48.2mm<br>垂直短轴: 32.6mm</span>
        </div>
        <div class="p-arrow">-&gt;</div>
        <div class="p-block highlight">
          <span class="p-badge">Step 4</span>
          <b>IBSI 影像组学</b>
          <span>形态学、GLCM 灰度共生矩阵等 107 项量化指标</span>
        </div>
      </div>
    </div>
  `,

  diff_heatmap_diagram: `
    <div class="diagram-wrap">
      <div class="diff-schema-grid">
        <div class="diff-item">
          <b>基线 CT (T0)</b>
          <span>奥希替尼靶向治疗前<br>靶病灶长径 48.2mm</span>
        </div>
        <div class="diff-math">+</div>
        <div class="diff-item">
          <b>3月随访 CT (T1)</b>
          <span>靶向治疗 3 个月后<br>病灶退缩至 28.1mm</span>
        </div>
        <div class="diff-math">-&gt; 3D 互信息配准 -&gt;</div>
        <div class="diff-item result">
          <b>体素级差分吸收热力图</b>
          <span style="color: #00ff93;">[冷色绿斑]: 吸收退缩 (容积变化 -58.3%)</span><br>
          <span style="color: #ef4444;">[暖色红斑]: 进展外侵 (Progression)</span><br>
          <span style="color: #38bdf8;">[RECIST 1.1 裁决]: 部分缓解 (PR)</span>
        </div>
      </div>
    </div>
  `,

  sarcopenia_diagram: `
    <div class="diagram-wrap">
      <div class="sarco-step-flow">
        <div class="s-step">
          <b>1. 全身解剖定位</b>
          <span>TotalSegmentator 104 类解剖先验，自下而上精准识别 L3 椎体中点</span>
        </div>
        <div class="s-arrow">-&gt;</div>
        <div class="s-step">
          <b>2. 肌肉与脂肪密度分层</b>
          <span>骨骼肌 SMA (-29~150 HU): 98.4 cm²<br>内脏脂肪 VAT (-150~-50 HU)</span>
        </div>
        <div class="s-arrow">-&gt;</div>
        <div class="s-step active">
          <b>3. 骨骼肌指数 (SMI) 计算</b>
          <span>SMI = 98.4 / 1.70² = 34.2 cm²/m²<br>（国际临界值 &lt; 55，诊断重度肌少症）</span>
        </div>
        <div class="s-arrow">-&gt;</div>
        <div class="s-step alert">
          <b>4. 药代毒性预警 (PK Warning)</b>
          <span>化疗清除率显著下调，3 级以上严重不良事件风险增加 2.8 倍</span>
        </div>
      </div>
    </div>
  `,

  consort_flow_diagram: `
    <div class="diagram-wrap">
      <div class="consort-visual-box">
        <div class="consort-node top">
          <b>初始筛查受试者人群 (Assessed for eligibility)</b>
          <span>N = 2,150 例门诊与住院原始档案</span>
        </div>
        <div class="consort-branch">
          <div class="consort-line-down"></div>
          <div class="consort-node-excl">
            <b>剔除不满足条件 (Excluded, n = 730)</b>
            <ul>
              <li>未满足纳入标准 (eGFR &lt; 30 mL/min): n = 540</li>
              <li>撤回知情同意书: n = 120</li>
              <li>其他严重并发症: n = 70</li>
            </ul>
          </div>
        </div>
        <div class="consort-node bottom">
          <b>最终达标纳入课题队列 (Enrolled Cohort)</b>
          <span>N = 1,420 例心衰受试者 (去标识化学术代号 S001 ~ S1420)</span>
        </div>
      </div>
    </div>
  `,

  table1_pipeline_diagram: `
    <div class="diagram-wrap">
      <div class="table1-flow-row">
        <div class="t1-step">
          <b>阶段 1: 变量分布自适应检验</b>
          <span>Shapiro-Wilk 检验：正态输出 Mean±SD (t检验)；偏态输出 Median[IQR] (Mann-Whitney)</span>
        </div>
        <div class="t1-arrow">-&gt;</div>
        <div class="t1-step">
          <b>阶段 2: 倾向评分匹配 (PSM)</b>
          <span>1:1 最邻近卡钳匹配，平衡混杂协变量，SMD 全部收敛至 &lt; 0.05</span>
        </div>
        <div class="t1-arrow">-&gt;</div>
        <div class="t1-step active">
          <b>阶段 3: 原生 Word (.docx) 生成</b>
          <span>顶线/底线 1.5pt、栏目线 0.5pt、宋体 / Times New Roman、统计检验脚注</span>
        </div>
      </div>
    </div>
  `,

  causal_survival_diagram: `
    <div class="diagram-wrap">
      <div class="causal-split">
        <div class="cs-box">
          <div class="cs-title">[因果推断与混杂抗辩] (Causal Inference)</div>
          <div class="cs-content">
            <b>[Love Plot 绝对标准化均数差 (SMD)]</b><br>
            <span>匹配前粗散点发散，匹配后全部收敛至 SMD &lt; 0.1 达标线内</span><br><br>
            <b>[VanderWeele E-value 未测混杂抗辩]</b><br>
            <span>计算得 E-value = 2.45（95% CI 下限 1.76），自动输出中英双语顶刊审稿人抗辩陈述</span>
          </div>
        </div>
        <div class="cs-box">
          <div class="cs-title">[生存分析与预测模型] (Survival & TRIPOD)</div>
          <div class="cs-content">
            <b>[24 个月 Kaplan-Meier 累积无事件生存曲线]</b><br>
            <span>达格列净组显著优于对照组，Log-rank P &lt; 0.001，附带风险人数表</span><br><br>
            <b>[多因素 Cox 比例风险回归与森林图]</b><br>
            <span>主要复合终点风险降低 26% (HR 0.74, 95% CI 0.65-0.85)，亚组高度一致</span>
          </div>
        </div>
      </div>
    </div>
  `,

  pubmed_guard_diagram: `
    <div class="diagram-wrap">
      <div class="guard-flow-container">
        <div class="g-step">
          <span class="g-num">Gate 1</span>
          <b>引文与效应量抽取</b>
          <span>AI 从文稿中提取 [PMID: 31535829] 及 HR 0.74 (0.65-0.85)</span>
        </div>
        <div class="g-arrow">-&gt;</div>
        <div class="g-step active">
          <span class="g-num">Gate 2</span>
          <b>NCBI 官方 XML 直连核验</b>
          <span>调用 E-Utilities API 拉取真实论文 XML 全文与摘要</span>
        </div>
        <div class="g-arrow">-&gt;</div>
        <div class="g-step highlight">
          <span class="g-num">Gate 3</span>
          <b>命题逐字核查与写前守卫</b>
          <span>数据 100% 吻合标记 Supported；行内红绿 Diff 确认，防止假文献</span>
        </div>
      </div>
      <div class="guard-mock-diff">
        <div class="diff-title">[行内微观差异比对] (Character-level Diff Preview)</div>
        <div class="diff-body">
          达格列净暴露组复合心力衰竭再住院风险
          <span class="diff-del">显著下降</span>
          <span class="diff-ins">降低 26%（HR 0.74, 95% CI 0.65–0.85, P&lt;0.001）</span>
          <span class="diff-badge-ok">[PubMed 官方核验通过: PMID 31535829]</span>
        </div>
      </div>
    </div>
  `,

  dual_mode_memory_diagram: `
    <div class="diagram-wrap">
      <div class="dual-mode-grid">
        <div class="dm-card">
          <div class="dm-h">[模式 1] IMRAD 论文排版模式 (Docs)</div>
          <span>段落稳定 Block ID，规范医学结构化排版，批注评论长效锚定</span>
        </div>
        <div class="dm-sync">
          <span class="sync-icon">&lt;-&gt;</span>
          <span class="sync-text">单一 Yjs CRDT 数据模型<br>毫秒级双向无锁同步</span>
        </div>
        <div class="dm-card">
          <div class="dm-h">[模式 2] 16:9 演示文稿模式 (Slides)</div>
          <span>8 种学术版式、院徽水印定制、纯 Rust WASM 4K 极速光栅化</span>
        </div>
      </div>
      <div class="memory-engine-bar">
        <b>[课题自主记忆演进系统]:</b>
        <span>观察医生采纳行为 -&gt; 沉淀 8 类核心口径 (纳排标准、终点定义、统计偏好) -&gt; 过期口径自动退役淘汰</span>
      </div>
    </div>
  `,

  dapa_hf_flywheel: `
    <div class="diagram-wrap">
      <div class="flywheel-flow">
        <div class="fw-node">1. PICO 纳排<br><span>2,150 筛选 1,420 例</span></div>
        <div class="fw-arrow">-&gt;</div>
        <div class="fw-node">2. 影像与多模态<br><span>超声/CT 与 24月生化</span></div>
        <div class="fw-arrow">-&gt;</div>
        <div class="fw-node active">3. PSM 与 Table 1<br><span>原生 Word 三线表</span></div>
        <div class="fw-arrow">-&gt;</div>
        <div class="fw-node">4. 沙箱统计<br><span>KM 曲线 & E-value</span></div>
        <div class="fw-arrow">-&gt;</div>
        <div class="fw-node highlight">5. 论文与幻灯片<br><span>双模一键导出</span></div>
      </div>
    </div>
  `,

  comparison_matrix_diagram: `
    <div class="diagram-wrap">
      <div class="radar-badges-row">
        <div class="r-badge mint">[文献真实性]: 100% PubMed 交叉验真</div>
        <div class="r-badge cyan">[3D 体素影像]: 原生 MONAI & RECIST 1.1</div>
        <div class="r-badge green">[隐私合规]: 独立 UID 无网沙箱 Zero-PHI</div>
        <div class="r-badge yellow">[成果交付]: 原生 Word 三线表 + 16:9 幻灯片</div>
      </div>
    </div>
  `,

  roadmap_airgap_diagram: `
    <div class="diagram-wrap">
      <div class="roadmap-grid">
        <div class="rm-phases">
          <div class="rm-p done"><b>Phase 1 (已就绪)</b>: 患者档案沉淀、受试者纳排、MONAI 3D 量化、原生 Table 1 与 CONSORT 流程图</div>
          <div class="rm-p done"><b>Phase 2 (已就绪)</b>: Docs & Slides 双模协同、纯 Rust 4K 渲染、PubMed 交叉验真、MCP 生产级接入</div>
          <div class="rm-p active"><b>Phase 3 (推进中)</b>: 科室多中心课题联邦协作网络、电子化知情同意 (e-Consent) 与 eCRF 自动化质控</div>
          <div class="rm-p"><b>Phase 4 (前瞻布局)</b>: 真实世界证据 (RWE) 主动发现与多模态虚拟患者队列 (Digital Twin Cohort)</div>
        </div>
        <div class="rm-airgap">
          <div class="airgap-title">[医院物理隔离私有化交付架构] (Airgap)</div>
          <div class="airgap-box">零公网外联 · Docker Compose 一键拉起 · 兼容国产化软硬件 · GPU/MPS 硬件加速</div>
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
