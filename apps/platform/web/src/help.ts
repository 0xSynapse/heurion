/**
 * Heurion 临床智能工作站 · 全流程产品使用手册与操作指南 (Product Help & Documentation)
 * 涵盖：
 * 1. 快速上手与界面导览
 * 2. 医学隐私与安全架构 (零 PHI、AES-256-GCM 隔离、高风险确认卡)
 * 3. 医学写作与文献溯源 (文档/幻灯片双模态、Word/PPTX/Markdown 无损双向导入导出、PubMed 智能引用、Python/Resvg 矢量图表)
 * 4. 患者管理与 3D 影像量化分析 (DICOM/NIfTI 上传、MONAI 3D 模型、MPR 三正交切片、双期 3D 刚性配准差分热力图、双联屏联动滑动、RECIST 1.1 与支扩 HAM/BAR 标准)
 * 5. 多模态因果诊断链与全景报告导出 (影像+化验+基因证据链、标准 DICOM SR 与 HL7 FHIR 导出)
 * 6. 临床科研工作流 (方案拟定、多源数据集质控、Table 1 基线表、Kaplan-Meier 生存曲线、Cox 回归)
 * 7. 科室协作、知家家庭空间 (PHR) 与安全分享
 * 8. 快捷键与常见问题解答 (FAQ)
 */

import { icon } from './icons.ts'

type ApiFn = <T = any>(path: string, opts?: RequestInit) => Promise<T>

export interface HelpSection {
  id: string
  title: string
  badge: string
  icon: string
  summary: string
  contentHtml: string
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'overview',
    title: '快速上手与界面导览',
    badge: '入门基础',
    icon: icon('globe', { size: 16 }),
    summary: '了解 Heurion 工作站的三栏交互架构、三大核心工作空间切换及基础业务闭环。',
    contentHtml: `
      <div class="help-section-head">
        <h3>1. 快速上手与界面导览</h3>
        <span class="help-tag">系统架构 · 交互布局</span>
      </div>
      <p class="help-lead">Heurion 专为临床医生、影像科专家及医学科研人员打造，融合现代化极简墨绿极客美学与严苛的循证医学严谨性。</p>
      
      <h4>1.1 经典三栏自适应界面</h4>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('folder', { size: 20 })}</div>
          <div class="hfc-title">左侧导航 Rail & 资源栏</div>
          <div class="hfc-desc">管理三大核心空间切换、文档树、资料库（PDF/指南上传向量化）、回收站及用户中心配置。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('file', { size: 20 })}</div>
          <div class="hfc-title">中间主工作画布 (Center)</div>
          <div class="hfc-desc">富文本无损编辑器、医学学术幻灯片排版器、患者 3D MPR 影像切片浏览器及科研数据集透视表。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-icon">${icon('sparkles', { size: 20 })}</div>
          <div class="hfc-title">右侧伴随智能栏 (Side AI)</div>
          <div class="hfc-desc">伴随式 AI 对话、红绿 Diff 修订逐条采纳、学术论文审查建议、PubMed 文献溯源与历史版本回滚。</div>
        </div>
      </div>

      <h4>1.2 三大核心业务空间</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('scan', { size: 14 })}</span>
          <div>
            <b>患者空间 (Patients Space · 临床第一线 · 默认落地)</b>：严格遵循「零 PHI」安全准则与纯虚拟代号建档。上传 DICOM / NIfTI 3D 影像，调用影像算法做量化测量（结果供科研参考），使用三正交 MPR 浏览器与双期对比工具辅助阅片。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('chart', { size: 14 })}</span>
          <div>
            <b>临床研究空间 (Research Space)</b>：从临床试验方案立项、纳入排除标准筛选，到上传 SAS/SPSS/Excel 多中心数据表，一键自动生成 Table 1 基线表、Kaplan-Meier 生存曲线、Cox 风险比森林图及 IBSI 影像组学预后分析。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('write', { size: 14 })}</span>
          <div>
            <b>写作空间 (Writing Space)</b>：支持起草临床指南、基金标书、SCI 论文、学术汇报幻灯片 (Deck) 及病历讨论。深度整合 PubMed 全球医学文献检索与 Python 矢量医学图表生成。
          </div>
        </li>
      </ul>

      <h4>1.3 极简医学发丝图标系统 (1.5px Hairline SVG)</h4>
      <p>全平台抛弃杂乱花哨的表情符号 (Emoji)，采用统一 1.5px 极简发丝级医学科技矢量 SVG 图标，与墨绿临床界面深度契合，带来专业沉浸的医生工作台体验。</p>

      <div class="help-callout tip">
        <span class="callout-icon">${icon('info', { size: 16 })}</span>
        <div class="callout-body">
          <b>快捷键小贴士：</b>
          随时使用 <code>⌘B</code> (粗体)、<code>⌘I</code> (斜体)、<code>⌘U</code> (下划线)、<code>⌘Z</code> (撤销)、<code>⌘⇧Z</code> (重做)。在 AI 对话框中，按 <code>⌘↩</code> 可快速提交推理指令。
        </div>
      </div>
    `
  },
  {
    id: 'concepts',
    title: '医学影像与核心逻辑通俗通识课 (零基础必读)',
    badge: '小白通识',
    icon: icon('book', { size: 16 }),
    summary: '专为非医学专业与跨学科人员编写：用生活化比喻系统拆解 CT/MRI/超声原理、体素与亨氏单位、窗宽窗位、MPR 三正交、印戒征与 BAR、高密度粘液栓、3D 弹性配准、差分热力图、RECIST 1.1、肌少症与影像组学。',
    contentHtml: `
      <div class="help-section-head">
        <h3>2. 医学影像与核心逻辑通俗通识课 (Zero-to-One Clinical Concepts Primer)</h3>
        <span class="help-tag ok">零基础速成 · 跨学科必读</span>
      </div>
      <p class="help-lead">医学影像与临床智能融合了放射物理学、人体解剖学、免疫病理学与高维计算机视觉。本章节专为非医学背景的工程师、科研人员及产品设计者编写，抛弃晦涩难懂的死记硬背，采用生活化生动比喻与因果链条，带您从零建立完整的临床认知模型。</p>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.1 常见影像模态到底能看清什么？(CT vs MRI vs 超声 vs PET-CT)</span>
          <span class="help-concept-badge">成像物理原理</span>
        </div>
        <p>很多初学者分不清做一次检查到底该拍 CT 还是磁共振 (MRI)。其实不同的设备就像具有不同超能力的“透视镜”：</p>
        <div class="help-analogy">
          <b>生活化比喻：</b>
          <ul>
            <li><b>CT (计算机断层扫描)</b>：就像把一个西瓜用极薄的刀切成几百片，每一片都用高能 X 光透视拍摄。它对<b>密度差异</b>极度敏感，最擅长看骨头（硬骨头白亮）和肺部（空气纯黑，结节灰白）。</li>
            <li><b>MRI (磁共振成像)</b>：完全没有辐射。它利用强磁场让体内的水分子（氢原子）“跳舞并产生共振”，接收水分子释放的无线电波。它对<b>含水软组织</b>极其敏感，最擅长看大脑神经、脊髓、关节韧带和前列腺。</li>
            <li><b>超声波 (Ultrasound)</b>：就像海豚或军用潜艇的声呐雷达，探头向身体里发射超声波并接收回音。它能够实时看到心脏搏动和血管里的血液流动（红蓝血流多普勒），适合查甲状腺、乳腺、胆囊和胎儿。</li>
            <li><b>PET-CT (正电子发射断层显像)</b>：CT 负责给身体画“精细解剖地图”，PET 则给身体装上“能量代谢探针”。因为恶性肿瘤细胞生长飞快，疯狂抢吃葡萄糖，注入带标记的微量“假糖”后，肿瘤细胞就会在扫描仪下像灯泡一样发光！</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>为什么临床要联合检查？</b> 
          因为“同病异影，同影异病”。例如一个肺部阴影，CT 看到形态像肿瘤，但无法确定是不是坏死组织；结合 PET-CT 发现阴影区域葡萄糖代谢极高，结合增强 MRI 发现周围血管侵犯，三者合一才能下定论。
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.2 为什么叫“体素 (Voxel)”？从二维贴纸到三维乐高积木</span>
          <span class="help-concept-badge">空间几何</span>
        </div>
        <p>普通电脑屏幕上的照片由长方形的<b>像素 (Pixel, Picture Element)</b> 构成，就像一张平面贴纸，只有长和宽，没有厚度。</p>
        <div class="help-analogy">
          <b>生活化比喻：</b>
          医学扫描生成的是三维立体数据。每一个采样点不仅有横纵坐标，还有扫描层与层之间的<b>切片厚度 (Slice Thickness)</b>。这个具有物理体积的三维立方块就叫<b>体素 (Voxel = Volume Pixel)</b>，就像一块具有明确长、宽、高尺寸的微小<b>乐高积木</b>。
        </div>
        <div class="help-why-need">
          <b>为什么不能直接拿 2D 像素算面积和体积？（各向异性痛点）</b>
          医院为了省时间或减少患者受辐射，经常扫描层厚较厚（例如水平切片上每个像素是 0.75×0.75 mm，但层与层之间间隔厚达 5 mm）。这时积木不是正方体，而是被压扁拉长的扁长方体（这在数学上叫<b>各向异性 Anisotropy</b>）。如果直接斜着切片或者算病灶体积，图像就会被严重拉伸失真！
        </div>
        <p><b>Heurion 平台怎么处理？</b> 平台读取影像时保留原始体素间距（如 0.7×0.7×5 mm），所有长度、面积与体积都按真实物理间距换算；三正交切片显示时按物理比例缩放，避免各向异性造成的拉伸。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.3 亨氏单位 (HU) 与窗宽窗位 (WW/WL)：医学“偏光太阳镜”的秘密</span>
          <span class="help-concept-badge">密度刻度与调窗</span>
        </div>
        <p>在 CT 图像中，不同组织显示出不同的黑白灰度，这个灰度对应的物理量叫<b>亨氏单位 (Hounsfield Unit, HU)</b>，以 CT 发明人、诺贝尔奖得主高弗雷·亨斯菲尔德命名。</p>
        <div class="help-analogy">
          <b>亨氏单位的标尺（以水为零点）：</b>
          <ul>
            <li><b>空气</b>：最轻、阻挡 X 光最少，定为 <code>-1000 HU</code>（图像上呈纯黑）；</li>
            <li><b>纯水</b>：标准零点，定为 <code>0 HU</code>；</li>
            <li><b>普通软组织与肌肉</b>：主要是水和蛋白质，一般在 <code>+40 ~ +50 HU</code>（中灰色）；</li>
            <li><b>致密骨骼与钙化</b>：含钙高、阻挡射线极强，高达 <code>+1000 ~ +3000 HU</code>（极亮纯白）。</li>
          </ul>
        </div>
        <div class="help-analogy">
          <b>为什么需要窗宽窗位 (Windowing)？——“偏光太阳镜”的比喻</b>
          人眼的视网膜在同一时刻最多只能识别 20~30 级灰度变化，但 CT 仪器的物理探测范围从 -1000 到 +3000 足足有 4000 多个灰阶！如果把这 4000 个数值硬生生挤在屏幕上，所有软组织都会挤成一片模糊的死灰。<br>
          因此，医生必须带上一副<b>“智能偏光太阳镜”</b>，只看我们关心的那一段密度：
          <ul>
            <li><b>窗位 (Window Level, 窗中心)</b>：你要观察的目标组织的中心密度（看肺泡空气就定在 -600 HU；看心脏纵隔就定在 +40 HU）；</li>
            <li><b>窗宽 (Window Width, 视野跨度)</b>：围绕窗位上下展开多少个数值跨度来映射显示器黑白。</li>
          </ul>
        </div>
        <p><b>Heurion 平台怎么操作？</b> 顶部工具栏内置一键快捷调窗：按 <b>肺窗</b>（看结节与支气管）、<b>纵隔窗</b>（看心脏大血管与粘液栓）、<b>腹部窗</b>（看肝肾胰腺）、<b>骨窗</b>（看骨折线）或鼠标直接在画面上按住左右上下拖拽无级微调。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.4 什么是 MPR 三正交切片？像切吐司一样透视人体</span>
          <span class="help-concept-badge">空间视图</span>
        </div>
        <p>平时体检拿到的 CT 胶片大都是横着切的（医生叫轴位或横断面）。但在复杂病变面前，单看横切面很容易“管中窥豹”。</p>
        <div class="help-analogy">
          <b>生活化比喻：切长方体吐司面包的三个方向</b>
          <ul>
            <li><b>横断面 (Axial / 轴状面)</b>：平放吐司，从头顶到脚底一片片平行切开（从上往下俯视人）；</li>
            <li><b>冠状面 (Coronal / 额状面)</b>：竖放吐司，从鼻尖到后脑勺一片片切开（正面面对人）；</li>
            <li><b>矢状面 (Sagittal / 侧状面)</b>：侧放吐司，从左耳朵到右耳朵一片片切开（侧面看人）。</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>为什么三正交联动不可或缺？</b>
          支气管像树枝一样斜着向四面八方生长。如果一根支气管斜着穿过横切面，医生只看到一个小圆点，无法判断这根管子在纵向上有没有被一整条长长的粘液栓堵死。而在冠状面和矢状面上，整根树枝的走向一目了然！
        </div>
        <p><b>Heurion 平台怎么操作？</b> 浏览器支持 WebGL2 实时四视图联动：移动任意一个切片上的十字准星，其他两个正交平面与 3D 立体模型会瞬间联动对齐到该空间点，毫秒级同步。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.5 支气管扩张的铁证：为什么叫“印戒征”？BAR 怎么算？</span>
          <span class="help-concept-badge">呼吸病学经典体征</span>
        </div>
        <div class="help-analogy">
          <b>正常解剖的“贴身卫士”常识：</b>
          在健康的肺部，输送空气的“支气管”和输送血液的“肺动脉小血管”是一对形影不离的搭档。在肺组织的任何一个截面上，它们总是紧挨在一起同行。正常情况下，输送空气的管子内径比血管稍小一点或差不多大。
        </div>
        <div class="help-analogy">
          <b>为什么叫“印戒征 (Signet Ring Sign)”？</b>
          当支气管因反复感染或变态反应遭到破坏而发生病理性扩张时，支气管腔变得异常宽大，而旁边的血管大小保持不变。在横截面上看：扩张的支气管是一个透亮的大圆圈（充气空腔），旁边紧挨着的小血管是一个白白实实的小圆点——两者组合在一起，极像西方古典贵族佩戴的<b>一枚镶嵌着珍珠宝石的指环印章</b>！
        </div>
        <div class="help-why-need">
          <b>BAR (支气管-伴行动脉比) 的数学计算：</b>
          BAR = 支气管内腔直径 / 伴行动脉外径。
          <ul>
            <li>BAR &lt; 1.0：正常；</li>
            <li>BAR &ge; 1.0：明确存在支气管扩张；BAR 数值越大（如 1.45），扩张越严重。</li>
          </ul>
        </div>
        <p><b>Heurion 平台怎么做？</b> 平台提供基于 HU 阈值的启发式算法，在关键层尝试配对支气管与伴行动脉并测量管径比；配对失败时显示「未测得」。该算法未经临床验证，结果需要放射科医师复核。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.6 什么是高密度粘液栓 (HAM)？为什么痰栓会变成“牙膏泥”？</span>
          <span class="help-concept-badge">ABPA 关键病理标志</span>
        </div>
        <p>普通感冒或支气管炎咳出的痰主要成分是水和粘液，在 CT 上的密度很低（约 0~20 HU，比普通肌肉暗很多）。</p>
        <div class="help-analogy">
          <b>痰栓为什么会变“硬”变“亮”？</b>
          在变应性支气管肺曲霉病 (ABPA) 这种免疫性疾病中，人体免疫细胞（嗜酸性粒细胞）在气道里疯狂聚集杀敌，最终大量同归于尽崩解，释放出极高浓度的钙、铁、锰等金属离子，并形成针尖状的“夏科-雷登结晶”。浓缩脱水后，稀薄的痰液变成了如同牙膏泥甚至橡胶块一样致密的栓子，把扩张的气道死死堵死（医学上叫指套征或牙膏征）。
        </div>
        <div class="help-why-need">
          <b>为什么高密度粘液栓 (HAM) 是诊断金标准？</b>
          在 CT 纵隔窗下观察，如果气管里的粘液栓密度<b>超过了旁边脊柱胸壁肌肉的密度（肌肉一般在 40~50 HU，HAM 常高达 70~120 HU 以上）</b>，即可确诊为高密度粘液栓 (HAM)。出现 HAM 说明患者免疫反应剧烈，是极易复发的高危重症信号，必须启动全身糖皮质激素联合抗真菌治疗！
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.7 随访对比为什么要配准？刚性配准 vs 弹性形变配准 (DIR) 与差分热力图</span>
          <span class="help-concept-badge">纵向多期随访</span>
        </div>
        <p>患者经过 3 个月治疗后回医院复查 CT，医生想知道“原来的病灶到底小了没有”。但直接对比两次片子非常困难。</p>
        <div class="help-analogy">
          <b>为什么不能直接叠图对比？——“气球”的比喻</b>
          人的肺就像一个充满弹性的大气球。两次检查相隔几个月，患者不可能吸进一模一样多的空气，躺在检查床上的肩膀体位也稍微歪了一点点。稍微吸大一口气，肺里的结节就能移动 2~3 厘米！如果把这两次扫描直接叠在一起，就像把两张不同角度拍摄的照片叠图，满屏都是错位假象。
        </div>
        <div class="help-analogy">
          <b>刚性配准 vs 弹性形变配准 (DIR)：</b>
          <ul>
            <li><b>刚性配准 (Rigid Registration)</b>：就像把两张硬纸板在桌上挪动、旋转对齐四边。它只能纠正整体的平移和歪斜，无法对付肺泡局部拉伸；</li>
            <li><b>3D 非刚性弹性形变配准 (Deformable Image Registration, DIR)</b>：就像把一块被揉皱的面团或丝巾，用数学形变位移场 (DVF) 在电脑里逐个体素抚平、拉伸，尽量让随访 CT 的解剖结构与基线 CT 对齐；配准误差总是存在，结果需要人工核对。</li>
          </ul>
        </div>
        <div class="help-why-need">
          <b>差分吸收热力图 (Difference Heatmap) 的奇迹：</b>
          完美对齐后，电脑计算前后两次 CT 每个像素的密度差异相减：
          <ul>
            <li><span style="color:#00ff93; font-weight:600;">● 绿色</span>：代表病灶吸收缩小了（治疗起效，好转缓解！）；</li>
            <li><span style="color:#ff6b6b; font-weight:600;">● 红色</span>：代表新出现了病灶或原来的病灶变大了（病情恶化进展！）；</li>
            <li><span style="color:#ffd000; font-weight:600;">● 黄色</span>：代表病灶既没有缩小也没有长大（稳定状态）。</li>
          </ul>
          注意：差分图只有在两次扫描已经准确对齐时才有意义；体位或呼吸幅度不同会产生假差异，颜色变化需要医生结合原始图像判断。
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.8 实体瘤缩了还是大了？肿瘤界通用的尺子：RECIST 1.1</span>
          <span class="help-concept-badge">肿瘤疗效评估</span>
        </div>
        <p>在抗肿瘤临床试验中，评价一种新靶向药到底管不管用，全世界有一把公认的度量衡——<b>RECIST 1.1 (实体瘤疗效评价标准)</b>。</p>
        <div class="help-analogy">
          <b>怎么测量和分类？</b>
          挑选最具代表性的肿瘤靶病灶（最多 5 个），用卡尺量取它们的最大长径，将长径加在一起算总和 (Sum of Diameters, SOD)：
          <ul>
            <li><b>CR (完全缓解，Complete Response)</b>：所有靶病灶消失。</li>
            <li><b>PR (部分缓解，Partial Response)</b>：病灶长径总和缩小了 30% 以上（有效缩小）；</li>
            <li><b>PD (疾病进展，Progressive Disease)</b>：病灶长径总和增大了 20% 以上，或者冒出了任何新病灶（恶化失控）；</li>
            <li><b>SD (疾病稳定，Stable Disease)</b>：缩小不足 30%、增大不足 20%，处于胶着僵持期。</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.9 隐匿性肌少症 (Sarcopenia)：为什么要在第三腰椎 (L3) 算 SMI？</span>
          <span class="help-concept-badge">机体成分分析</span>
        </div>
        <div class="help-analogy">
          <b>临床痛点：“虚胖”的癌症患者</b>
          很多癌症晚期患者站上体重秤发现体重正常甚至偏胖，但医生却很担忧。因为这些患者体内的肌肉已经被癌细胞大量吞噬消耗，被无用的水肿和脂肪填满，这种现象叫<b>“隐匿性肌少症 (Sarcopenia)”</b>。肌肉量极度匮乏的患者，往往扛不住下一轮化疗或靶向药的毒性副作用，极易发生严重感染甚至早期死亡。
        </div>
        <div class="help-why-need">
          <b>为什么全世界医生都选第三腰椎 (L3)？</b>
          大量解剖学和尸检数据证实：<b>人体第 3 腰椎切面上的骨骼肌总面积（包括腰大肌、竖脊肌和腹部肌肉），与人体全身的总肌肉储备有着严格正比的数学线性关系！</b> 只要扫一个腹部平扫，看一眼 L3 层面，就能准确推算全身肌肉营养状况。
        </div>
        <div class="help-why-need">
          <b>骨骼肌指数 (SMI) 的计算公式：</b>
          SMI = L3 层面骨骼肌总横截面积 (cm²) / [患者身高 (m)]² (单位: cm²/m²)。
          <ul>
            <li>文献中常用的 Prado 等阈值为男性 SMI &lt; 52.4 cm²/m²、女性 &lt; 38.5 cm²/m²；SMI 只是肌少症评估的一项影像指标，诊断还需结合肌力与体能检查。平台目前的体成分分析为阈值法、L3 层为启发式选层，缺少身高时不计算 SMI。</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.10 什么是 IBSI 影像组学 (Radiomics)？“肉眼看不见的微观数字指纹”</span>
          <span class="help-concept-badge">AI 科研特征工程</span>
        </div>
        <p>人类放射科医生即使经验再丰富，肉眼也只能看到“这个结节边缘不太光滑、里面有点发白”。</p>
        <div class="help-analogy">
          <b>电脑眼中的微观纹理：</b>
          对计算机而言，医学影像本质是一个包含成千上万个离散数值的三维数字矩阵。两个表面看起来一样的肿瘤，一个内部细胞排列松散均匀，另一个内部细胞疯狂挤压增殖、灰度剧烈跳跃。这些隐藏在像素灰度分布背后的高阶微观数学特征，就叫<b>影像组学特征 (Radiomics Features)</b>。
        </div>
        <div class="help-why-need">
          <b>提取这些特征有什么用？</b>
          IBSI 对常用组学特征（球形度、一阶直方图、灰度共生矩阵 GLCM、灰度游程 GLRLM 等）给出了标准化定义。把这些特征提取出来存入表格，科研人员可以探索它们与临床结局的关联；组学模型需要独立数据验证，不能替代病理与基因检测。平台目前计算 46 项特征，尚未与 IBSI 参考值做一致性校验。
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.11 什么是 PET-CT 的 SUV？肿瘤细胞疯狂吃糖的信号</span>
          <span class="help-concept-badge">分子代谢显像</span>
        </div>
        <div class="help-analogy">
          <b>生活化比喻：</b>
          把身体想象成一个热闹的城市。恶性肿瘤细胞就像正在秘密举行狂欢派对的房间。我们向全身静脉注射一种带有微量安全同位素辐射的“假葡萄糖”(&sup1;&sup8;F-FDG)。狂欢的肿瘤细胞为了增殖抢着大口吃糖，吃得越多，发出的放射线就越强。<br>
          <b>SUV (Standardized Uptake Value, 标准摄取值)</b> 就是测量这个病灶吃糖的强度到底比人体全身平均水平高出几倍！
        </div>
        <div class="help-why-need">
          <b>核心参数指标说明：</b>
          <ul>
            <li><b>SUVmax (最大标准摄取值)</b>：病灶中最活跃、发光最亮的那个单点的摄取倍数。良性病灶往往较低，恶性肿瘤 SUVmax 常常超过 2.5 甚至高达 15~30 以上；</li>
            <li><b>MTV (代谢肿瘤体积)</b>：病灶中真正具有高代谢活性的肿瘤核心体积（剔除了死掉的坏死区）；</li>
            <li><b>TLG (总糖酵解量)</b>：TLG = MTV &times; SUVmean，代表肿瘤全身消耗葡萄糖的总能量负荷，是评估靶向药物把癌细胞饿死了多少的最佳指标。</li>
          </ul>
        </div>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.12 放疗的“电子围栏”：什么是 DICOM RT-STRUCT？</span>
          <span class="help-concept-badge">肿瘤放射治疗规划</span>
        </div>
        <div class="help-analogy">
          <b>生活化比喻：</b>
          肿瘤放射治疗（放疗）就像用超高能量的光子射线机关枪消灭癌细胞。但身体里有很多极其娇嫩的重要器官（比如脊髓神经、心脏大血管、直肠壁），一旦被射线过量打中就会瘫痪或坏死。因此，医生必须在 3D 图像上给射线规划精密的“电子围栏”：
          <ul>
            <li><b>GTV (大体肿瘤体积)</b>：肉眼或 AI 明确看到的实体肿瘤；</li>
            <li><b>CTV (临床靶区)</b>：GTV 加上可能潜伏有微小癌细胞扩散的周边安全防御缓冲带；</li>
            <li><b>OAR (危及器官)</b>：周边需要千方百计避让的正常器官（如脑干、视神经、脊髓）。</li>
          </ul>
        </div>
        <p><b>什么是 RT-STRUCT？</b> 它是 DICOM 标准中存放三维勾画轮廓的文件格式。Heurion 目前只能在医生提供的 GTV 掩膜上做几何外扩（CTV / PTV），<b>不自动勾画 GTV、不导出 DICOM RT-STRUCT 文件</b>，不能用于放疗计划。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.13 为什么不能单凭一张片子下诊断？多模态因果诊断链的闭环逻辑</span>
          <span class="help-concept-badge">临床循证思维</span>
        </div>
        <div class="help-analogy">
          <b>现代临床三元证据链：</b>
          医生在看病时，从来不敢仅仅因为“CT 发现肺里有一块阴影”就草率下结论。因为同样的阴影既可能是真菌感染，也可能是肺结核或恶性肺癌。必须结合三层证据相互锁死：
          <ul>
            <li><b>第一层（宏观解剖形态 · 影像）</b>：CT 发现中央型支气管扩张伴高密度粘液栓 (HAM)；</li>
            <li><b>第二层（机体免疫反应 · 化验生化）</b>：验血发现嗜酸性粒细胞绝对值超标 (&gt; 0.5 &times; 10⁹/L)，总 IgE 突破天际 (&gt; 1000 IU/mL)，烟曲霉特异性抗体阳性；</li>
            <li><b>第三层（病原学与微观病理 · 金标准）</b>：气管镜洗出黏稠黄色痰栓，镜下找到曲霉菌丝或夏科-雷登结晶。</li>
          </ul>
        </div>
        <p><b>Heurion 平台怎么做？</b> 平台在「患者中心」按规则清单把影像测量值、化验结果与病史标签逐项列出（阳性 / 阴性 / 缺失），帮助医生查漏补缺；它不是诊断模型，结论由医生给出。</p>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.14 为什么必须严防死守“零 PHI”？法律底线与本地沙盒隔离</span>
          <span class="help-concept-badge">医疗合规与法律边界</span>
        </div>
        <p><b>PHI 是什么？</b> 全称是 <b>Protected Health Information (受保护的健康信息)</b>。包括患者真实姓名、身份证号码、电话号码、医保卡号、住院号、甚至带有面部特征的 3D 头颅扫描。</p>
        <div class="help-why-need">
          <b>为什么不能直接将带姓名的病历发给 AI 模型？</b>
          国内外法律法规（HIPAA、GDPR、数据安全法）对医疗健康隐私有极其严苛的追责要求。任何真实的患者姓名如果未经许可被上传到第三方大模型云端服务器进行训练或推理，一旦泄露，医疗机构和科研人员将面临严重的行政处罚甚至吊销执业资质。
        </div>
        <p><b>Heurion 平台的双重保险架构：</b></p>
        <ul>
          <li><b>云端与大模型视角</b>：只看到去标识化的虚拟代号（如 <code>PT-BRONCHO-001</code>），所有进出云端的数据完全清洗掉个人敏感信息；</li>
          <li><b>医生个人视角</b>：医生如果给代号加了备注名（如“张阿姨”），这个名字只保存在医生当前电脑浏览器的 <code>localStorage</code> 中，不随表单发送到服务器数据库；换电脑或清除浏览器数据后需要重新填写。</li>
        </ul>
      </div>

      <div class="help-concept-box">
        <div class="help-concept-head">
          <span>2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺</span>
          <span class="help-concept-badge">几何测量与物理标定</span>
        </div>
        <div class="help-analogy">
          <b>生活化比喻：</b>
          屏幕上的像素点就像手机屏幕上的微型发光灯泡，手机缩放图片时灯泡密度会变化。如果直接拿一把塑料尺在显示器表面量“肿块有 3 厘米长”，在 13 寸笔记本上可能是 3 厘米，在 27 寸大屏上就变成了 6 厘米！这就像拿一根弹性极大的橡皮筋去量布料长短一样荒唐。
        </div>
        <div class="help-why-need">
          <b>为什么必须依靠“物理体素标定 (Voxel Spacing)”？</b>
          CT 或 MRI 机在扫描患者身体时，会在 DICOM 头文件中严格写入每一个体素在人体三维真实解剖空间中的物理毫米跨度 (如 Pixel Spacing = 0.72 mm/像素，层厚 = 1.0 mm)。系统前端必须实时将鼠标在屏幕上画出的屏幕像素坐标差 $(\Delta x, \Delta y)$，乘以真实的物理标尺常数，才能精准换算为患者体内真实的物理长径与横截面积。
        </div>
        <p><b>Heurion 平台怎么做？</b> 采用双层 Canvas 交互系统，提供亚毫米级高对比度电子游标卡尺与两点包围盒截面积测量，并将测量线段与原始医学切片进行离屏双层合成无损固化入库。</p>
      </div>
    `
  },
  {
    id: 'privacy',
    title: '医学隐私与安全架构 (零 PHI)',
    badge: '安全合规',
    icon: icon('shield', { size: 16 }),
    summary: '了解零 PHI 准则、AES-256-GCM 租户数据密钥隔离、高风险操作二次确认卡与敏感操作审计机制。',
    contentHtml: `
      <div class="help-section-head">
        <h3>3. 医学隐私与安全架构 (Zero-PHI & Compliance)</h3>
        <span class="help-tag danger">核心准则 · 严禁违规</span>
      </div>
      <p class="help-lead">医疗数据的隐私与安全是 Heurion 的立身之本。系统严格按照 HIPAA、GDPR 及国家卫生健康数据合规标准设计架构。</p>

      <h4>3.1 强制零 PHI (Zero Protected Health Information) 准则</h4>
      <p>为了从根本上规避患者真实隐私外泄风险，Heurion 采用<b>「全流程纯代号化」</b>建档与分析机制：</p>
      <div class="help-alert-box alert-important">
        <b>${icon('shield', { size: 14 })} 严格禁止输入任何真实患者个人敏感信息：</b>
        <ul>
          <li>禁止在患者档案、主诉、病史文本或对话框中输入真实患者姓名、身份证号、医保卡号、门诊住院号或电话号码。</li>
          <li>请统一使用虚拟研究代号建档，例如：<code>PT-BRONCHO-001</code>、<code>SUBJ-PROSTATE-2026-A</code>。</li>
          <li>上传的 DICOM 影像文件若包含原始私有 Tag，系统在入库前将自动进行脱敏擦除 (De-identification)。</li>
        </ul>
      </div>

      <h4>3.2 租户级数据密钥加密隔离</h4>
      <p>每个医院或科研机构拥有独立的 AES-256-GCM 数据加密密钥 (DEK)。即使在底层数据库物理层面，不同租户之间的数据相互隔离，防止跨机构越权访问。</p>

      <h4>3.3 高风险操作确认卡 (Human-in-the-Loop)</h4>
      <p>AI 在系统中具备高阶辅助分析能力，但<b>不具备最终裁决权</b>。当 AI 提议执行不可恢复或高敏感操作时（如：删除患者随访数据、覆盖既往病历、下发正式诊断报告），系统会自动弹窗生成<b>「待确认操作卡」</b>，必须由执业医师主动点击确认后方才执行。</p>

      <h4>3.4 访问审计留痕 (Audit Trail)</h4>
      <p>所有对患者病历、3D 影像切片及临床科研数据集的查阅、下载与导出行为，均自动记录包含操作医师 ID、时间戳、操作模态及脱敏患者代号的不可篡改审计日志。</p>
    `
  },
  {
    id: 'writing',
    title: '医学写作与文献溯源',
    badge: '创作引擎',
    icon: icon('write', { size: 16 }),
    summary: '文档与学术汇报幻灯片双模态编辑、Word/PPTX/Markdown 无损双向导入导出、PubMed 智能引用及 Resvg 矢量图表。',
    contentHtml: `
      <div class="help-section-head">
        <h3>4. 医学写作与文献溯源 (Medical Writing & Evidence Tracing)</h3>
        <span class="help-tag">写作 · 幻灯片 · 文献</span>
      </div>
      <p class="help-lead">支持文档 (Docs) 与幻灯片 (Slides) 双模态自由创作，专为学术发表与科室汇报量身打造。</p>

      <h4>4.1 双模态创作中心</h4>
      <table class="help-table">
        <thead>
          <tr>
            <th>功能维度</th>
            <th>文档写作 (Doc)</th>
            <th>学术汇报幻灯片 (Deck)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>适用场景</b></td>
            <td>SCI 论文、病例报告、临床指南解读、基金标书</td>
            <td>学术年会汇报、病历讨论读片会、科研文献解读</td>
          </tr>
          <tr>
            <td><b>编辑特性</b></td>
            <td>块级富文本、分级标题、公式、表格、PubMed 自动引用</td>
            <td>医学专业主题模板、网格等距排列、图文自适应对齐</td>
          </tr>
          <tr>
            <td><b>格式导出</b></td>
            <td>Word (.docx)、Markdown (.md)</td>
            <td>PowerPoint (.pptx)、全量高清渲染图片</td>
          </tr>
          <tr>
            <td><b>无损导入</b></td>
            <td>直接导入本地 .docx，保留标题层级与原样样式</td>
            <td>直接导入本地 .pptx，保留版式排版与图形占位</td>
          </tr>
        </tbody>
      </table>

      <h4>4.2 AI 伴随修订模式 (Suggest / Diff Mode)</h4>
      <p>在右侧对话框上方，常驻<b>「修订模式 · 生成 Diff 待采纳」</b>开关：</p>
      <ul>
        <li><b>开启修订模式（推荐）</b>：AI 针对正文的润色、新增证据、语法精炼会作为红绿 Diff 标记渲染在画布上。您可以点击单处修订单独采纳/拒绝，亦可点击「全部采纳」。</li>
        <li><b>关闭修订模式</b>：AI 将直接修改正文，适用于快速重构大纲或从零起草全新段落。</li>
      </ul>

      <h4>4.3 PubMed 智能文献检索与参考资料库</h4>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>实时插入规范引用</b>：点击工具栏「引用」按钮，输入 DOI (如 <code>10.1056/NEJMoa2307563</code>) 或 PMID，系统自动抓取文章元数据（作者、期刊、发表年、卷期页码），自动编排 [1], [2] 标注并在文末生成参考文献列表。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>参考资料库 (Library / RAG)</b>：在左侧 Rail 点击「资料库」，可拖入本地 PDF 指南或文献。系统自动抽取文字与切块向量化。在对话时勾选「＋ 引用资料」，AI 将基于指南原文精准作答并标注出处页码。
          </div>
        </li>
      </ul>

      <h4>4.4 高清矢量图表生成与无损导出保护</h4>
      <p>AI 可根据临床数据通过 Python 自动绘制森林图、生存曲线、箱线图并嵌入正文。系统采用 Resvg 高性能矢量渲染引擎与 DrawingML 双模嵌入技术，导出 Word 或 PowerPoint 时保持矢量清晰。</p>
    `
  },
  {
    id: 'imaging',
    title: '患者管理与 3D 影像量化分析',
    badge: '临床核心',
    icon: icon('scan', { size: 16 }),
    summary: '零 PHI 虚拟代号建档、多期化验时间序列追踪、DICOM/NIfTI 空间解析、MONAI 3D 深度模型矩阵（胸部支扩/粘液栓/肺结节、前列腺 mpMRI、腹部 13 器官、脑部 MRI）及交互式 MPR 三正交切片浏览器。',
    contentHtml: `
      <div class="help-section-head">
        <h3>5. 患者管理与 3D 影像量化分析 (Patient Management & 3D Imaging Quantification)</h3>
        <span class="help-tag ok">零 PHI · MONAI 3D · MPR 交互</span>
      </div>
      <p class="help-lead">深度打通「临床患者全景档案」与「3D 体素级影像量化分析」，既保障医疗隐私绝对安全，又赋予医生亚毫米级的定量诊断与智能读片能力。</p>

      <h4>5.0 影像智能分析全流程业务闭环 (The Complete 9-Step Imaging Pipeline)</h4>
      <p>Heurion 影像系统严格遵循现代循证放射学与多学科临床诊疗路径，打通从原始图像摄入到治疗评估与科研输出的九大完整业务阶段：</p>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">① 影像摄入与合规脱敏</div>
          <div class="hfc-desc">支持 DICOM 序列/NIfTI 体数据上传，上传 DICOM 时清除常见身份标签；也可在对话中上传单张截图请 AI 辅助描述（不构成诊断）。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">② 空间几何与重采样</div>
          <div class="hfc-desc">统一到 LPS 方向并保留原始体素间距；提供肺窗、纵隔窗、腹部窗、骨窗及脑窗预设。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">③ MONAI 模型与量化算法</div>
          <div class="hfc-desc">接入多款 MONAI Model Zoo 官方权重与若干阈值法量化算法，各项完成度不一；模型类型（深度学习 / 定量 CT / 规则算法）与可用状态以模型列表为准，详见 5.4 与第 8 章。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">④ 影像组学特征提取</div>
          <div class="hfc-desc">从病灶 ROI 计算 46 项特征（形状、一阶统计、GLCM、GLRLM），尚未与 IBSI 参考值做一致性校验。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑤ MPR 三正交交互式切片</div>
          <div class="hfc-desc">Axial/Coronal/Sagittal 自由十字丝联动；5cm 物理标尺，病灶质心准星一键定位与关键切片资产存证。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑥ 纵向随访与差分图</div>
          <div class="hfc-desc">两期体数据差分图（不含配准）与实验性形变配准，双视窗同步滚动比对；详见第 6 章。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑦ PET-CT 融合（实验）</div>
          <div class="hfc-desc">使用请求给出的 CT 与 PET（同网格；PET 须已是 SUV；须给 ROI 或生理性摄取排除说明），给出 SUVmax、SUVmean 与阈值体积。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑧ 放疗靶区外扩（实验）</div>
          <div class="hfc-desc">由医生提供的 GTV 掩膜外扩生成 CTV / PTV，不自动勾画 GTV，不导出 DICOM RT-STRUCT 文件。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">⑨ 证据清单与结构化导出</div>
          <div class="hfc-desc">按规则清单列出影像、化验与病史的阳性 / 阴性 / 缺失项；可导出 FHIR 或 DICOM SR 结构的 JSON。</div>
        </div>
      </div>

      <h4>5.1 患者全流程档案建立与零 PHI 隐私规范 (Zero-PHI Patient Registry)</h4>
      <p>为满足 HIPAA、GDPR 及医疗机构核心数据合规要求，平台推行严格的<b>零真实个人标识 (Zero-PHI)</b> 体系：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>纯虚拟代号建档 (Research Code)</b>：患者入组统一采用去标识化的代号（如 <code>PT-BRONCHO-001</code>、<code>SUBJ-2026-08</code>）。系统同时支持记录性别、出生年份（自动推算当前实足年龄）及疾病标签（如 <code>哮喘</code>、<code>支气管扩张</code>、<code>ABPA</code>、<code>肺结节</code>、<code>前列腺癌</code>、<code>靶向治疗中</code>），支持标签一键过滤。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>本机浏览器备注名物理隔离 (Local Private Names)</b>：
            医生如需在本地辨识患者姓名，可直接在患者代号旁添加备注名。<b>该备注名只保存在当前电脑浏览器的 <code>localStorage</code> 中</b>，不随表单发送到服务器数据库；换电脑或清除浏览器数据后需重新填写。
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <b>多维档案工作区 (Workspaces)</b>：
            <ul>
              <li><b>概览 (Overview)</b>：汇总患者简要病史、关键体征、关联科研课题 (Studies & Subject ID) 以及关联的查房报告与病历文档；</li>
              <li><b>化验 (Labs)</b>：管理时间序列多期检验数据，支持纵向演变趋势可视化；</li>
              <li><b>报告原件与影像 (Records)</b>：归档出院小结、病理报告、生化检验单原件及 DICOM/NIfTI 影像计算档案；</li>
              <li><b>待确认操作 (Review / Human-in-the-Loop)</b>：AI 从原件中抽取的指标或提议的病历修改，需在此处由医生点击「采纳」或「驳回」。</li>
            </ul>
          </div>
        </li>
        <li>
          <span class="step-num">4</span>
          <div>
            <b>医疗协作与权限机制</b>：支持设定主管医师 (Owner) 与参与医生 (Member) 权限；提供针对危急值抢救情境的<b>「紧急破窗访问 (Break-Glass Access)」</b>全流程审计；支持生成受控<b>「安全分享码 (Share Code)」</b>向科室同事或家庭只读共享化验与报告。
          </div>
        </li>
      </ul>

      <h4>5.2 多模态实验室检验指标追踪与时间序列管理 (Longitudinal Lab Analytics)</h4>
      <p>化验单不仅是静态记录，更是临床评估病情演进的重要证据链：</p>
      <div class="help-grid-2">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('chart', { size: 14 })} 核心检验指标全覆盖</div>
          <div class="hfc-desc">
            <ul>
              <li><b>变态反应与呼吸</b>：外周血嗜酸性粒细胞绝对值 (Eos #) 与百分比 (Eos %)、血清总 IgE、烟曲霉特异性 sIgE；</li>
              <li><b>肿瘤标志物</b>：CEA、CYFRA21-1、NSE、PSA、游离 PSA (fPSA)；</li>
              <li><b>感染与炎症生化</b>：CRP、降钙素原 (PCT)、肝肾功能、血气分析等。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('refresh', { size: 14 })} 跨机构单位自动换算与原件追溯</div>
          <div class="hfc-desc">
            <ul>
              <li><b>国际标准单位归一化</b>：不同仪器与机构的化验单位（如 10⁹/L 与 /μL、IU/mL 与 kU/L）自动换算为统一标准单位，悬停可追溯原测值，确保数年随访趋势严密可比；</li>
              <li><b>原件精准溯源 (Traceability)</b>：点击化验项可一键跳转并高亮检验单 PDF 原件的对应页码与测量区域。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>5.3 3D 原始影像支持与空间几何解析 (3D Volumetric Imaging & Geometry)</h4>
      <p>平台采用原生的三维体数据解析管线，支持高分辨率医学影像的端到端量化：</p>
      <table class="help-table">
        <thead>
          <tr>
            <th>特性维度</th>
            <th>技术规格与临床规范</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>格式支持</b></td>
            <td>
              1. <b>DICOM 序列压缩包 (<code>.zip</code> / <code>.tar.gz</code>)</b>：流式递归解压、自动校验并排序数百张连续轴位切片；<br>
              2. <b>单张 DICOM (<code>.dcm</code>)</b>；<br>
              3. <b>科研标准三维 NIfTI 卷 (<code>.nii</code> / <code>.nii.gz</code>)</b>。
            </td>
          </tr>
          <tr>
            <td><b>空间几何提取</b></td>
            <td>自动解析体素空间物理间距 (Voxel Spacing 如 0.75×0.75×1.25 mm)、体素空间矩阵维度 (Dimensions 如 512×512×280) 与解剖方位坐标系 (LPS / RAS)。</td>
          </tr>
          <tr>
            <td><b>影像模态覆盖</b></td>
            <td>
              1. <b>CT / HRCT</b>：高分辨率薄层 CT 平扫与增强扫描，支持支气管与粘液栓测量、肺结节候选、肺气肿密度定量与腹部器官分割（BTCV）；<br>
              2. <b>MRI / mpMRI</b>：头颅 T1/T2/FLAIR/DWI 神经序列、前列腺多参数磁共振 (T2+ADC+DWI)；<br>
              3. <b>超声与便携声像 (Ultrasound)</b>：支持通过对话上传或报告归档导入腹部、心脏、甲状腺与浅表超声切片，AI 结合临床既往史进行声像学特征判读；<br>
              4. <b>X 线胸片 (DR/CR)</b>：正侧位胸片病灶筛查；<br>
              5. <b>PET-CT</b>：CT 与 PET 同网格时做融合显示与 SUV 统计（PET 须已换算为 SUV，并提供 ROI 或生理性摄取排除说明）。
            </td>
          </tr>
          <tr>
            <td><b>敏感 Tag 脱敏</b></td>
            <td>影像入库前，后台自动清洗并抹除患者姓名、住院号、机构名、技师代号等私有 DICOM Tag，确保医学科研合规安全。</td>
          </tr>
        </tbody>
      </table>

      <h4>5.4 模型与量化算法现状 (Model Status)</h4>
      <p>影像分析时的模型列表来自影像服务，每个模型标明类型：<b>深度学习</b>（MONAI 官方权重）、<b>定量 CT</b>（HU 密度测量）、<b>规则算法</b>（阈值 / 形态学，非神经网络）。不可用的模型会显示原因（如「本地权重未安装」「引擎未实现」「已下线」），调用时影像服务返回 501。所有输出仅供科研参考，不构成诊断意见。</p>

      <div class="help-grid-2">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('scan', { size: 14 })} 深度学习（MONAI 官方权重，权重校验通过才可用）</div>
          <div class="hfc-desc">
            <ul>
              <li><b>脾脏分割</b>（spleen_ct_segmentation，3D UNet）；</li>
              <li><b>BTCV 腹部 13 类器官分割</b>（SwinUNETR）；「胰腺 / 双肾 / 肝脏」选项就是 BTCV 器官分割中对应的类别，只给器官体积，<b>不识别病灶</b>；</li>
              <li>前列腺分带、BraTS 胶质瘤子区（需 4 通道 MRI 并声明通道顺序）、心室短轴单期相分割（单期相不能计算射血分数）、全身 104 类结构分割等，以模型列表显示的可用状态为准。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('warning', { size: 14 })} 规则算法与定量 CT（非神经网络）</div>
          <div class="hfc-desc">
            <ul>
              <li><b>规则算法</b>：支气管-动脉径比与粘液栓容积、肺结节候选筛查与测量、L3 层体成分（HU 阈值法，启发式选层，不判定肌少症，缺身高不计算 SMI）、椎体松质骨 ROI 平均 CT 值（不换算骨密度）、交互式种子点区域生长；</li>
              <li><b>定量 CT</b>：肺气肿密度定量（LAA-950%、Perc15），<b>不做 GOLD 分级</b>。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('shield', { size: 14 })} 已下线 / 未实现</div>
          <div class="hfc-desc">
            <ul>
              <li>冠状动脉钙化积分（已下线：缺少心脏 / 冠脉区域来源，不能按标准 Agatston 方法计分）；</li>
              <li>病毒性肺炎病灶分割、气道树分割、肺叶分割、脑梗死分割、颅内出血检测：未实现，列表中显示为不可用，不提供入口。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('check', { size: 14 })} 使用建议</div>
          <div class="hfc-desc">
            <ul>
              <li>先看模型类型与可用状态；规则算法与定量 CT 的结果请对照原始图像逐项核对；</li>
              <li>模型列表中的分类导航只是界面分组，不代表该模型已经验证。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>5.5 诊断级交互式 MPR 三正交切片浏览器 (Multi-Planar Reconstruction)</h4>
      <p>点击任何已完成分析的影像记录，即可打开全功能交互式 MPR 诊断工作台：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>双引擎极速渲染</b>：
            <ul>
              <li><b>2D 正交切片引擎</b>：轻量极速，内置 5cm 毫米级解剖标尺与 HUD 参数抬头显示；</li>
              <li><b>NiiVue 3D WebGL2 引擎</b>：GPU 硬件加速，支持 3D 空间立体旋转体绘制 (Volume Rendering) 与横断面+冠状面+矢状面+3D模型四视图联动。</li>
            </ul>
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>三正交解剖平面自由切换</b>：
            <b>横断面 (Axial)</b>、<b>冠状面 (Coronal)</b>、<b>矢状面 (Sagittal)</b> 自由切换，切片滑块、鼠标滚轮上下滑动或键盘 ↑/↓/←/→ 连贯逐层浏览。
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <b>全模态临床标准窗宽窗位 (WW/WL) 一键调窗</b>：
            预设肺窗 (-600 / 1500 HU)、纵隔窗 (40 / 400 HU)、腹部窗 (50 / 350 HU)、骨窗 (300 / 1500 HU) 及脑窗 (40 / 80 HU)，并支持鼠标拖拽无级微调。
          </div>
        </li>
        <li>
          <span class="step-num">4</span>
          <div>
            <b>三维准星与智能病灶导航</b>：
            点击<b>「${icon('target', { size: 13 })} 定位病灶中心」</b>按钮，系统自动依据 3D 卷积分割范围质心瞬时跳转到病灶最大截面层；抬头显示<b>「病灶探测标签 (Lesion Badge)」</b>，实时提示当前切片是否有病灶受累。
          </div>
        </li>
        <li>
          <span class="step-num">5</span>
          <div>
            <b>关键截面存证截图与文档资产沉淀 (Key Slice Snapshot)</b>：
            点击<b>「${icon('save', { size: 13 })} 保存切片为文档资产」</b>，当前层位影像及窗宽窗位、物理标尺等参数自动转存为平台永久图像资产，并生成 Markdown 引用代码，可直接插入医学论文或汇报幻灯片；点击<b>「${icon('report', { size: 13 })} 一键生成放射诊断报告」</b>更可自动汇总参数出具规范影像报告草案。
          </div>
        </li>
      </ul>

      <h4>5.6 诊断级 3D MPR 前端轻量标注与卡尺交互量化系统 (Frontend Lightweight Annotation & Caliper Engine)</h4>
      <p class="help-lead">为了满足临床影像科与肿瘤科医生对靶病灶长短径快速测量、非规则剖面截面积标定及无损切片存证的核心诉求，Heurion 在 MPR 切片器前端构建了轻量级双层 Canvas 交互与亚毫米物理标定引擎：</p>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.1 完整功能设计 (Full Functional Design)</div>
        <div class="hfc-desc">
          <ul class="help-list-steps" style="margin-top: 8px;">
            <li>
              <span class="step-num">${icon('search', { size: 14 })}</span>
              <div>
                <b>浏览模式 (Browse Mode)</b>：默认交互模式。鼠标滚轮或切片滑动条平滑滚动，十字准星动态指引空间层位，与三正交平面保持实时联动。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('caliper', { size: 14 })}</span>
              <div>
                <b>游标卡尺测距模式 (Caliper Mode)</b>：点击工具栏卡尺按钮激活。在切片任意位置按下鼠标并拖动，实时生成高反差翡翠绿几何测距线段；线段两端自动绘制垂直阻挡游标卡脚 (Tick marks)，中央悬浮半透明深色 HUD 读数气泡，直观显示亚毫米物理长度（如 <code>24.0 mm</code>），完全符合临床放射测量习惯。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('ruler', { size: 14 })}</span>
              <div>
                <b>矩形剖面 ROI 面积模式 (ROI Area Mode)</b>：点击工具栏 ROI 按钮激活。通过两点对角线拖拽，生成半透明绿色填充的包围盒，实时自动计算物理横截面积，并在读数徽标中自适应显示为 <code>mm²</code> 或 <code>cm²</code>。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('refresh', { size: 14 })}</span>
              <div>
                <b>清除标注 (Clear)</b>：点击「清除标注」按钮，即刻擦除当前切片的手工测量轨迹，使画布恢复纯净浏览状态。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('save', { size: 14 })}</span>
              <div>
                <b>双图层复合无损存证 (Composite Snapshot Export)</b>：点击「保存切片为文档资产」，离屏 Canvas 引擎自动将底层原始灰阶切片与顶层卡尺标注合成为单张无损 PNG 图像，固化为平台不可篡改的永久医学图像资产，并自动生成 Markdown 引用代码直接插入医学写作空间。
              </div>
            </li>
            <li>
              <span class="step-num">${icon('report', { size: 14 })}</span>
              <div>
                <b>自动化诊断报告草案动态注入 (Diagnostic Report Draft Injection)</b>：点击「出具影像诊断报告」，手工实测的长短径与截面积自动被提取并注入至四段式结构化诊断报告中（例如在影像所见段落自动追加：<code>- 手工卡尺测量: 长径 24.0 mm, ROI 截面积 3.72 cm²</code>），实现临床测量与文书的 Human-in-the-Loop 责任闭环。
              </div>
            </li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.2 交互实现架构 (Interactive Implementation Architecture)</div>
        <div class="hfc-desc">
          <ul>
            <li><b>双层 Canvas DOM 覆盖架构</b>：切片展示区采用分层渲染解耦设计，底层包含 512×512 像素的 <code>&lt;img id="mprImg"&gt;</code> 负责灰阶切片图像呈现；顶层覆盖绝对定位的 <code>&lt;canvas id="mprAnnotCanvas" width="512" height="512"&gt;</code> 专门负责标注交互；通过 CSS <code>pointer-events</code> 属性精准控制鼠标穿透与事件捕获，浏览模式下零额外开销。</li>
            <li><b>事件驱动状态机 (State Machine)</b>：
              <ul>
                <li><code>pointerdown</code>：捕获起始像素坐标 $(x_1, y_1)$，锁定拖拽起点并记录当前激活工具；</li>
                <li><code>pointermove</code>：高帧率监听拖动位置 $(x_2, y_2)$，利用 <code>requestAnimationFrame</code> 驱动双缓冲局部重绘，清空上一帧并平滑绘制当前卡尺/矩形及半透明读数徽标；</li>
                <li><code>pointerup</code>：固化几何终点坐标，更新内存测量元数据结构，供后续报告草案调用。</li>
              </ul>
            </li>
            <li><b>视网膜高清屏 (Retina Display) 锐化适配</b>：读取宿主设备的 <code>window.devicePixelRatio</code>（通常为 2 或 3），动态放大 Canvas 绘图缓冲区物理尺寸，减少高分辨率屏幕上测量线段的模糊或锯齿。</li>
            <li><b>人机工程学高反差视觉</b>：主测量线采用抗混叠翡翠绿 (#00E599 / #34D399)；两端卡脚长度为 8px 垂直阻挡游标；读数气泡采用半透明暗黑底色 (rgba(6, 17, 13, 0.85)) 搭配发丝边框，确保在最黑的肺野和最白的硬骨上均具备极其清晰的可读性。</li>
          </ul>
        </div>
      </div>

      <div class="help-feature-card" style="margin: 14px 0;">
        <div class="hfc-title">5.6.3 算法量化原理与物理标定 (Algorithm & Physics Calibration)</div>
        <div class="hfc-desc">
          <p>屏幕坐标无法直接代表解剖尺寸。系统通过严密的物理体素标定算法实现几何精准映射：</p>
          <table class="help-table" style="margin: 8px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>算法步骤</th>
                <th>数学物理公式</th>
                <th>参数意义与临床精度保障</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><b>1. 空间体素间距提取</b></td>
                <td>$S_x = \\text{PixelSpacing}[0]$ (mm/px)<br>$S_y = \\text{PixelSpacing}[1]$ (mm/px)</td>
                <td>由 DICOM 元数据 Tag (0028, 0030) 获取物理间距，通常为 0.5~0.8 mm/体素。</td>
              </tr>
              <tr>
                <td><b>2. 画布坐标步长归一</b></td>
                <td>$k_x = \\frac{\\text{dim}_x \\times S_x}{512}, \\quad k_y = \\frac{\\text{dim}_y \\times S_y}{512}$</td>
                <td>将 512×512 标准化前端交互画布像素坐标映射至原始切片实际物理范围。</td>
              </tr>
              <tr>
                <td><b>3. 欧氏真实物理间距</b></td>
                <td>$D_{\\text{mm}} = \\sqrt{\\left[(x_2 - x_1) \\cdot k_x\\right]^2 + \\left[(y_2 - y_1) \\cdot k_y\\right]^2}$</td>
                <td>两点间各向异性校正欧几里得距离，直接对应实体瘤 RECIST 1.1 靶病灶长径与短径。</td>
              </tr>
              <tr>
                <td><b>4. 截面积尺度自适应</b></td>
                <td>$A_{\\text{mm}^2} = \\left(|x_2 - x_1| \\cdot k_x\\right) \\times \\left(|y_2 - y_1| \\cdot k_y\\right)$<br>当 $A \\ge 100 \\text{ mm}^2$ 时，自动折算 $A_{\\text{cm}^2} = A / 100$</td>
                <td>计算病灶剖面面积，智能切换单位，避免临床医生手工换算繁琐与单位笔误风险。</td>
              </tr>
              <tr>
                <td><b>5. 离屏双层合成固化</b></td>
                <td>$\\text{CompositeCanvas} = \\text{DrawImage}(\\text{Slice}) + \\text{DrawImage}(\\text{Canvas})$<br>导出 $\\text{Base64 PNG}$ 并发送至 <code>/api/imaging/mpr/slice</code></td>
                <td>将医生手工测量的实物刻度与底图像素紧密缝合，永久存证并可直接提交 PACS 审计。</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <h4>5.7 L3 层面体成分分析（阈值法，实验）</h4>
      <p>当前实现按 HU 阈值划分骨骼肌、内脏脂肪与皮下脂肪，L3 层为启发式选层（不是 TotalSegmentator 模型，也不做椎体识别）。缺少身高时不计算骨骼肌指数 (SMI)，平台不给出肌少症结论；面积结果需要人工核对层面与分区。</p>

      <h4>5.8 影像组学特征提取 (Radiomics Extraction)</h4>
      <ul>
        <li>计算三维形状、一阶统计、灰度共生矩阵 (GLCM)、灰度游程矩阵 (GLRLM) 共 46 项特征，可存入研究数据集；</li>
        <li>尚未与 IBSI 参考数据集或 PyRadiomics 做一致性校验，不含 GLSZM、NGTDM 与小波滤波特征。</li>
      </ul>

      <h4>5.9 影像报告草稿</h4>
      <p>在影像卡片上点击<b>「${icon('report', { size: 13 })} 全景诊断报告」</b>，可汇总检查参数、算法测量值、关键切片与证据清单，生成报告草稿；草稿需医师审阅修改后才能保存为正式记录。</p>
    `
  },
  {
    id: 'registration',
    title: '双期对比、差分图与配准（实验功能）',
    badge: '实验功能',
    icon: icon('compare', { size: 16 }),
    summary: '基线与随访两期体数据的 CT 值差图（要求同网格）、双视窗同步滚动，以及处于实验阶段的形变配准、PET-CT 融合与放疗靶区外扩（均使用请求给出的真实影像）。',
    contentHtml: `
      <div class="help-section-head">
        <h3>6. 双期对比、差分图与配准 (Longitudinal Comparison & Registration · 实验功能)</h3>
        <span class="help-tag">随访对比 · 实验功能</span>
      </div>
      <p class="help-lead">本章功能都需要同一受试者的两次扫描才有意义。下面按当前代码的实际实现如实说明，部分功能仍处于实验阶段，输出只供科研参考。</p>

      <h4>6.1 双期差分图 (Difference Map)</h4>
      <ul>
        <li><b>实现方式</b>：两期体数据逐体素相减（随访 − 基线），按 HU 阈值（默认 50 HU）把差值叠加到切片上：绿色表示 CT 值下降、红色表示升高，并给出两类体积。</li>
        <li><b>要求与局限</b>：不做配准、不做插值，两期的体素网格（形状与间距）必须一致，否则直接报错；即使网格一致，体位与呼吸差异也会产生差值。平台<b>不给「吸收」「进展」等趋势结论</b>。</li>
      </ul>

      <h4>6.2 形变配准（实验）</h4>
      <ul>
        <li><b>实现方式</b>：<code>registration.run_3d_deformable_registration</code> 用基于强度梯度的迭代位移场（Demons 类方法）对齐两期体数据，报告配准前后的归一化互相关 (NCC)、均方误差降幅与最大位移。</li>
        <li><b>局限</b>：未在公开配准基准上验证，也不是 MONAI 配准网络；结果需人工核对。</li>
      </ul>

      <h4>6.3 双视窗同步滚动</h4>
      <p>在随访对比弹窗中左右并排两个切片视窗，勾选「锁定同步滚动」后，两侧按层号的相对比例同步翻页（按比例对应，不是按配准后的解剖位置对应）。</p>

      <h4>6.4 PET-CT 融合与放疗靶区外扩（实验）</h4>
      <ul>
        <li><b>输入</b>：两个接口都使用请求给出的真实影像，不再使用合成数据；缺影像时返回 400 / 404。</li>
        <li><b>PET-CT 融合</b>：CT 与 PET 必须在同一网格（先配准重采样）；PET 体素值必须已换算为 SUV（平台不做换算，需确认 <code>pet_values_are_suv</code>）；统计范围必须给 ROI 掩膜，或说明 PET 体积已如何排除生理性摄取。按 SUV 阈值（默认 2.5）给出 SUVmax、SUVmean、阈值体积与伪彩叠加图，不给诊断结论。</li>
        <li><b>靶区外扩</b>：必须提供医生勾画的 GTV 掩膜（与 CT 同网格），平台<b>不自动勾画 GTV</b>；按设定边距外扩生成 CTV / PTV（CTV 去除骨性体素与体外空气）并给出体积与轮廓图。未做剂量学验证，<b>不导出 DICOM RT-STRUCT 文件</b>，不能用于放疗计划。</li>
        <li><b>形变配准</b>：固定图像与浮动图像都由请求给出，且须在同一网格。</li>
      </ul>

      <h4>6.5 疗效评估标准</h4>
      <div class="help-callout important">
        <span class="callout-icon">${icon('shield', { size: 16 })}</span>
        <div class="callout-body">
          <ul>
            <li><b>实体瘤</b>：RECIST 1.1 按靶病灶长径之和的变化判定（PR：缩小 ≥ 30%；PD：增大 ≥ 20% 且绝对值增加 ≥ 5 mm；其余为 SD），判定需由医师完成。</li>
            <li><b>非实体瘤病变（如粘液栓）</b>：RECIST 1.1 不适用；平台没有经过验证的体积疗效标准，体积变化只作描述性记录。</li>
          </ul>
        </div>
      </div>
    `
  },
  {
    id: 'diagnostics',
    title: '证据清单与标准格式导出',
    badge: '报告导出',
    icon: icon('evidence', { size: 16 }),
    summary: '把影像量化结果、化验指标与病史标签对照规则清单逐项列出（阳性 / 阴性 / 缺失），生成报告草稿，并可导出 FHIR 或 DICOM SR 结构的 JSON。',
    contentHtml: `
      <div class="help-section-head">
        <h3>7. 证据清单与标准格式导出 (Evidence Checklist & Export)</h3>
        <span class="help-tag">报告草稿 · 结构化导出</span>
      </div>
      <p class="help-lead">平台不做诊断。本章功能只是把已有数据按规则清单整理出来，帮助医师查漏补缺；结论由医师给出。</p>

      <h4>7.1 证据清单 (Evidence Checklist)</h4>
      <ul>
        <li><b>实现方式</b>：根据影像记录的类型选择一套规则清单（如支扩/粘液栓、肺部占位、肺气肿、腹部脏器），逐项对照患者已录入的化验指标与病史标签，标记为阳性、阴性或缺失，并列出缺失的待查项。</li>
        <li><b>局限</b>：规则清单是固定条目的匹配，不是经过验证的诊断模型；任何「符合」或「提示」都只是清单匹配结果，不等于诊断。</li>
      </ul>

      <h4>7.2 报告草稿</h4>
      <p>在患者影像页面可生成报告草稿，汇总检查参数、算法测量值、关键切片截图与清单结果；草稿需要医师审阅修改后才能使用。</p>

      <h4>7.3 结构化导出</h4>
      <ul>
        <li><b>HL7 FHIR R4</b>：导出 DiagnosticReport（含 ImagingStudy 与 Observation）JSON 资源包。</li>
        <li><b>DICOM SR</b>：按 TID 1500 结构组织的 JSON 表示（SOP Class <code>1.2.840.10008.5.1.4.1.1.88.22</code>），不是二进制 DICOM 文件，不能直接导入 PACS，需要院内接口再转换。</li>
      </ul>
    `
  },
  {
    id: 'casestudy',
    title: '【算法演示】公开数据集上的影像算法输出',
    badge: '算法演示',
    icon: icon('sparkles', { size: 16 }),
    summary: '用公开数据集样本实际运行平台已有的影像算法（MONAI 脾脏分割、三正交 MPR、RECIST 径线测量、影像组学特征），图上每个轮廓、卡尺和数值都是计算结果；不是临床病例，不构成诊断意见。',
    contentHtml: `
      <div class="help-section-head">
        <h3>8. 公开数据集算法演示 (Algorithm Demos on Public Datasets)</h3>
        <span class="help-tag ok">公开数据集 · 算法实际输出 · 非临床病例</span>
      </div>
      <p class="help-lead">本章的图片全部由 <code>scripts/generate_all_case_study_images.py</code> 在 <code>apps/imaging-worker/data/</code> 的公开数据集样本上实际运行平台算法生成，图上每一个分割轮廓、测量卡尺和数值都来自计算结果，可重复运行复现。体数据统一转换到 LPS 方向后渲染：轴位图上方为前、图像左侧为患者右。<b>这些都是公开数据集上的算法输出演示，不是临床病例，也不构成诊断意见。</b></p>

      <div class="help-feature-card" style="margin: 16px 0; border-left: 3px solid var(--accent); background: rgba(56, 189, 248, 0.05);">
        <div class="hfc-title">${icon('shield', { size: 14 })} 8.0 本章未收录的内容及原因</div>
        <div class="hfc-desc">
          <ul>
            <li><b>疗效差分热力图 / 随访对比</b>：需要同一受试者的两次扫描，公开样本中没有，因此不展示；</li>
            <li><b>L3 体成分与骨骼肌指数 (SMI)</b>：当前实现为 HU 阈值法、L3 层为启发式选层，且公开样本没有身高数据，无法计算 SMI，因此不展示；</li>
            <li><b>前列腺 MRI 分区</b>：MONAI 前列腺权重在现有样本上没有得到有效分割，因此不展示；</li>
            <li><b>支气管扩张与粘液栓定量</b>：现有实现为启发式阈值法，在示例样本上的关键层落在肺门，候选区可能是血管或淋巴结，因此不展示；</li>
            <li><b>病理、分期、基因、化验与治疗经过</b>：公开影像样本不含这些信息，本章不做任何此类描述。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>8.1 MONAI 3D-UNet 脾脏自动分割与体积测量</span>
          <span class="help-case-tag">${icon('check', { size: 12 })} 模型推理输出</span>
        </div>
        <img class="help-case-img" src="/site/demo-spleen-monai-segmentation.png" alt="公开腹部 CT 样本上的 MONAI 脾脏分割结果" />
        <div class="help-case-caption">
          <ul>
            <li><b>数据</b>：公开数据集样本 <code>spleen_test</code>（腹部 CT，体素 0.703×0.703×5.0 mm）；</li>
            <li><b>算法</b>：MONAI 官方 spleen_ct 3D-UNet 权重滑窗推理，随后用 <code>recist.calculate_recist_metrics</code> 计算体积与最大截面最长径；</li>
            <li><b>本次结果</b>：分割 51,737 个体素，体积 127.89 cm³；最大截面在第 76 层，最长径 87.8 mm。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>8.2 三正交多平面重建 (MPR)</span>
          <span class="help-case-tag">${icon('grid', { size: 12 })} 三正交平面</span>
        </div>
        <img class="help-case-img" src="/site/demo-chest-mpr-3view.png" alt="公开胸部 CT 样本的轴位、冠状位、矢状位重建" />
        <div class="help-case-caption">
          <ul>
            <li><b>数据</b>：公开数据集样本 <code>chest_lung_ct</code>（胸部 CT，体素 0.898×0.898×1.25 mm）；</li>
            <li><b>处理</b>：统一到 LPS 方向后直接取三个正交平面，按物理间距等比例显示，未做任何病灶标注；十字定位在体数据几何中心。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>8.3 肺结节 RECIST 1.1 径线与体积测量</span>
          <span class="help-case-tag">${icon('check', { size: 12 })} 数据集标注 + 算法测量</span>
        </div>
        <img class="help-case-img" src="/site/demo-lidc-nodule-recist.png" alt="公开胸部 CT 样本上的肺结节 RECIST 测量" />
        <div class="help-case-caption">
          <ul>
            <li><b>数据</b>：公开数据集样本 <code>lidc_lung_nodule_ct</code>，ROI 使用样本附带的结节标注掩膜，不是平台自动分割的结果；</li>
            <li><b>算法</b>：<code>recist.calculate_recist_metrics</code> 选最大截面层，经凸包求最长径并计算垂直方向最大跨度与三维体积；</li>
            <li><b>本次结果</b>：关键层第 89 层，最长径 31.2 mm，垂直方向最大跨度 26.2 mm，体积 7.47 cm³；</li>
            <li><b>说明</b>：只有一个时间点，不涉及疗效评估。</li>
          </ul>
        </div>
      </div>

      <div class="help-case-card">
        <div class="help-case-header">
          <span>8.4 三维影像组学特征提取</span>
          <span class="help-case-tag">${icon('chart', { size: 12 })} 46 项特征</span>
        </div>
        <img class="help-case-img" src="/site/demo-lidc-nodule-radiomics.png" alt="公开胸部 CT 样本肺结节的影像组学特征节选" />
        <div class="help-case-caption">
          <ul>
            <li><b>数据</b>：与 8.3 相同的 ROI；</li>
            <li><b>算法</b>：<code>radiomics.extract_radiomics_features</code>，计算三维形状 15 项、一阶统计 18 项、GLCM 6 项、GLRLM 7 项，共 46 项；</li>
            <li><b>本次结果（节选）</b>：体积 7.466 cm³，球形度 0.5287，均值 −141.08 HU；</li>
            <li><b>局限</b>：该实现尚未与 IBSI 参考数据集或 PyRadiomics 做一致性校验。</li>
          </ul>
        </div>
      </div>

      <p class="help-lead" style="margin-top: 14px;">复现方法：<code>apps/imaging-worker/.venv/bin/python scripts/generate_all_case_study_images.py</code>。脚本会打印每张图的关键数值，以及未生成图片的原因。</p>
    `
  },
  {
    id: 'research',
    title: '临床科研工作流 (Research)',
    badge: '统计分析',
    icon: icon('chart', { size: 16 }),
    summary: '方案设计、多中心质控清洗、零 PHI 脱敏、Auto-eCRF 穿梭溯源、原生 Word Table 1 基线表、Kaplan-Meier 与 Cox 森林图、列线图 (Nomogram) 与 ROC/DCA 决策曲线、因果推断 E-value 及一键 SCI 投稿包 (.zip)。',
    contentHtml: `
      <div class="help-section-head">
        <h3>9. 临床科研工作流 (Clinical Research & Automated Biostatistics)</h3>
        <span class="help-tag">科研立项 · 多中心质控 · 自动化生物统计 · 顶刊闭环</span>
      </div>
      <p class="help-lead">Heurion 研究工作空间深度面向临床医学科学家、规培/专培医师及临床药理研究团队，提供从科研课题立项设计、多源多格式数据表质控导入、零 PHI 敏感数据脱敏、Auto-eCRF 影像与检验指标批量提取与 3D 切片热力图穿梭溯源、患者库智能入组、受限沙箱生物统计学制表（Table 1/KM/Cox/Nomogram/ROC/DCA）、未测混杂敏感性分析 (VanderWeele E-value)，到论文写作引用核验及一键导出 SCI 投稿出版包 (.zip) 的全生命周期科研支撑体系。</p>

      <h4>9.1 科研课题立项与研究方案结构化起草 (Protocol Design & Registry)</h4>
      <p>进入「研究 (Research)」工作空间，点击<b>「＋ 新建研究」</b>，可建立具有国际规范的课题档案：</p>
      <ul>
        <li><b>课题核心标识 (Study Metadata)</b>：录入研究内部代号（如 <code>ST-HFREF-2026-001</code>）、中英文全称、主要研究者 (PI) 及参与机构。</li>
        <li><b>伦理与注册登记 (IRB & Registry)</b>：关联医院机构伦理审查委员会批件编号（如 <code>IRB-2026-MED-0428</code>），支持录入中国临床试验注册中心 (ChiCTR) 或国际 ClinicalTrials.gov (NCT ID)，并在文章导出时自动溯源。</li>
        <li><b>PICO 框架结构化方案制定</b>：
          <ul>
            <li><b>P (Population/目标患病人群)</b>：设定疾病类型（如 HFrEF 射血分数降低心衰）、纳排标准详细条款（如年龄、LVEF 范围、NYHA 分级、生化指标界限）。</li>
            <li><b>I (Intervention/干预暴露因素)</b>：试验药物或治疗方案（如 SGLT2 抑制剂 恩格列净/达格列净 联合四联标准抗心衰治疗 GDMT）。</li>
            <li><b>C (Comparator/对照方案)</b>：阳性对照、标准对照或安慰剂（如 单纯 GDMT 标准治疗）。</li>
            <li><b>O (Outcome/研究终点事件)</b>：定义主要终点 (Primary Endpoint: 心血管死亡或因心衰加重紧急住院的复合事件 MACE) 与次要终点 (全因死亡、KCCQ-12 心衰生活质量评分、eGFR 复合肾终点)。</li>
          </ul>
        </li>
        <li><b>样本量与统计功效前置估算 (Power & Sample Size Calculator)</b>：内置专业临床样本量计算器，输入预期 HR（如 0.70）、双侧显著性水平 \\(\\alpha = 0.05\\)、统计功效 \\(1-\\beta = 80\\%\\) 及预估年事件发生率，系统自动测算所需最少受试者样本量与观察事件总数，确保研究设计具备统计学严谨性。</li>
      </ul>

      <h4>9.2 多源临床数据表导入、智能字典解析与零 PHI 脱敏 (Dataset Ingestion, QC & Zero-PHI Curation)</h4>
      <p>在研究项目的「数据集」面板中，系统提供强大的数据接入与治理引擎：</p>
      <div class="help-grid-3">
        <div class="help-chip-card"><b>.csv / .xlsx / .xls</b><span>通用表格文件 (支持 GBK/UTF-8 编码与多 Sheet 自动探测)</span></div>
        <div class="help-chip-card"><b>.sas7bdat</b><span>SAS 统计分析数据集 (保留原始变量格式与标签映射)</span></div>
        <div class="help-chip-card"><b>.sav / .dta</b><span>SPSS / Stata 二进制数据文件 (解析数值字典与缺失值定义)</span></div>
      </div>
      <p>导入数据后，系统即刻触发多层次质控与安全处理：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">${icon('search', { size: 14 })}</span>
          <div>
            <b>变量字典与数据类型智能推断 (Variable Dictionary)</b>：自动识别连续型变量（正态或偏态）、二分类变量、无序多分类变量、等级有序变量及生存结局变量（随访时间与结局状态 0/1）。对于 SAS/SPSS 文件的数值编码（如 <code>1 = 男, 2 = 女</code>），自动解析值标签 (Value Labels)。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('shield', { size: 14 })}</span>
          <div>
            <b>零 PHI 敏感信息红标拦截与前端物理脱敏 (Zero-PHI Scrubbing)</b>：对上传字段进行深度隐私合规审查，自动扫描并识别姓名、身份证号、电话、家庭住址及原始住院号。系统强制弹出脱敏确认卡，将敏感身份映射为不可逆的虚拟研究受试者编号（如 <code>S001, S002...</code>），研究数据集中只保留研究编号；是否满足具体法规要求需由所在机构评估。
          </div>
        </li>
        <li>
          <span class="step-num">${icon('warning', { size: 14 })}</span>
          <div>
            <b>缺失值与极端异常值自动化质控 (Automated QC)</b>：按变量生成缺失率报告（&lt; 5% 优良、5%~20% 警示、&gt; 20% 严重），支持中位数插补、多重链式方程插补 (MICE)；基于 3-Sigma 原则与 Tukey 四分位距 (IQR) 检出逻辑异常值（如收缩压 350 mmHg 或年龄 150 岁）并进行标红高亮预警。
          </div>
        </li>
      </ul>

      <h4>9.3 患者库多维条件筛选入组与动态队列生成 (Cohort Builder & Registry Linkage)</h4>
      <p>平台打通临床诊疗「患者」工作区与「研究」工作区，支持基于真实病历直接构建研究队列：</p>
      <ul>
        <li><b>多维逻辑布尔检索</b>：支持组合诊断（ICD-10 / 疾病分类）、处方用药（ATC 药物编码）、生化检验阈值（如 NT-proBNP ≥ 600 pg/mL、eGFR ≥ 20 mL/min/1.73m²）及人口学指标；</li>
        <li><b>3D 影像表型智能联动</b>：可将影像中心量化的特征（如 LVEF、RECIST 径线、病灶体积）作为纳入排除条件；</li>
        <li><b>队列生成与列式隔离存储</b>：点击「生成研究队列」，系统自动提取对应患者的时间序列检验单、病史信息及影像指标，生成受控列式 Parquet 格式数据集，自动去标识化后载入课题沙箱。</li>
      </ul>

      <h4>9.4 隔离受限沙箱自动化医学统计分析 (Automated Biostatistics & Sandboxed Execution)</h4>
      <p>Heurion 提供开箱即用、完全透明且可审计的生物统计引擎。所有运算均在隔离的沙箱容器中执行，调用标准 Python 统计生态（<code>scipy</code>, <code>statsmodels</code>, <code>lifelines</code>, <code>scikit-learn</code>），支持一键查阅和复制完整分析代码：</p>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">${icon('template', { size: 14 })} Table 1 基线三线表</div>
          <div class="hfc-desc">
            <ul>
              <li><b>正态性自适应</b>：连续变量自动进行 Shapiro-Wilk 检验，正态数据输出 <code>Mean ± SD</code> (t 检验)，偏态数据输出 <code>Median (IQR)</code> (Wilcoxon 检验)；</li>
              <li><b>分类变量自适应</b>：计数变量输出 <code>N (%)</code>，根据最小期望频数自动选用 Pearson 卡方检验或 Fisher 确切概率法；</li>
              <li><b>组间平衡</b>：两组比较时可计算标准化均数差 (SMD)；平台目前不提供倾向评分匹配 (PSM)。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('chart', { size: 14 })} Kaplan-Meier 生存分析</div>
          <div class="hfc-desc">
            <ul>
              <li><b>高精度曲线渲染</b>：绘制带 95% 置信区间的阶梯状累积生存率或累积风险曲线；</li>
              <li><b>Log-Rank 统计检验</b>：自动计算 \\(\\chi^2\\) 统计量与精确 p 值，计算中位生存时间 (Median OS / PFS)；</li>
              <li><b>风险人数表 (Number at Risk)</b>：严格对齐时间轴展示随访节点在险人数、事件发生数与截尾数，完全符合 NEJM / Lancet 制图标准。</li>
            </ul>
          </div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">${icon('dna', { size: 14 })} Cox 比例风险与森林图</div>
          <div class="hfc-desc">
            <ul>
              <li><b>等比例风险假定检验</b>：基于 Schoenfeld 残差检验比例风险假定 (PH Assumption)；</li>
              <li><b>单因素/多因素逐步回归</b>：校正混杂协变量，输出校正风险比 (Adjusted HR) 及 95% CI；</li>
              <li><b>预设亚组交互检验 (Forest Plot)</b>：针对年龄、性别、并发症及生物标志物自动生成高清亚组森林图，标定交互作用 P 值 (\\(P_{\\text{interaction}}\\))。</li>
            </ul>
          </div>
        </div>
      </div>

      <h4>9.5 影像生物标志物生存分析与预后建模 (Imaging Biomarker Survival Analysis)</h4>
      <p>将深度学习影像量化指标与长期临床随访结局深度融合：</p>
      <ul>
        <li><b>按影像指标分组</b>：把研究数据集中的影像测量值（如 RECIST 径线、体积、组学特征）按研究者设定的阈值分组，绘制 Kaplan-Meier 曲线并计算 Log-Rank p 值；</li>
        <li><b>多因素 Cox 回归协变量校正</b>：将影像标志物与年龄、TNM 临床分期、ECOG 评分及化疗周期联动构建多因素 Cox 回归模型，自动输出 Adjusted HR 及森林图；</li>
        <li><b>组学特征入库</b>：46 项影像组学特征可存入研究数据集，供研究者自行建模分析（模型需独立验证）。</li>
      </ul>

      <h4>9.6 论文稿件与学术幻灯片成果闭环 (Manuscript Integration & Research Closed-Loop)</h4>
      <p>打通「研究」与「写作」之间的数字鸿沟，减少数据复制粘贴中的人为笔误：</p>
      <ul>
        <li><b>课题上下文无缝绑定</b>：在写作编辑器中新建研究论文或汇报 PPT 时，直接关联指定研究课题；</li>
        <li><b>数据与图表动态绑定引用</b>：在正文中通过 <code>{{research.table1}}</code>、<code>{{research.km_curve}}</code> 实时插入矢量图表，统计数字直接挂钩数据库。若随访数据补充更新，文档中的数值一键全量联动刷新；</li>
        <li><b>顶级期刊格式无损导出</b>：一键导出包含高分辨率矢量图表、规范三线表和正确格式引文的 Word (.docx) 手稿与学术汇报幻灯片 (.pptx)。</li>
      </ul>

      <h4>9.7 CONSORT 2010 受试者入组筛选流向图与矢量导出 (CONSORT 2010 Flow Diagram & Mermaid)</h4>
      <p>为满足国际顶级医学期刊（NEJM、Lancet、JAMA 等）对临床试验与前瞻性队列研究的严格审稿要求，平台依据 CONSORT 2010 声明标准全自动构建并输出 Figure 1 受试者入组筛选流程图：</p>
      <ul>
        <li><b>只用真实入组记录</b>：默认流向图只画平台入组记录里有的环节（入组、移出、在组人数）；平台没有筛选人数、排除原因与治疗分组登记，因此不绘制这些环节，也不估算人数；</li>
        <li><b>自定义完整 CONSORT 图</b>：研究者可按原始纳排记录自行填写评估人数、排除原因与分组人数，生成完整 CONSORT 2010 流程图；</li>
        <li><b>矢量图形与 Mermaid 源码双向导出</b>：支持一键导出 Publication-Ready 高清矢量图 (SVG / 300+ DPI PNG)；提供标准 <code>Mermaid.js</code> 流程图源码一键复制，方便在 Markdown 讲义、LaTeX 文稿及幻灯片中随时自由二开与重绘。</li>
      </ul>

      <h4>9.8 未测混杂敏感性分析：VanderWeele E-value (Unmeasured-Confounding Sensitivity Analysis)</h4>
      <p>观察性研究常被问到：「未测量的混杂因素是否足以推翻结论？」平台提供 E-value 计算：</p>
      <ul>
        <li><b>E-value 计算</b>：按 VanderWeele &amp; Ding (2017) 公式，由效应量（RR / HR / OR，按需近似换算）计算点估计与置信区间界限对应的 E-value；置信区间跨过 1 时界限 E-value 记为 1.00；</li>
        <li><b>结果表述</b>：生成中英文的结果描述段落，供作者在回复审稿意见时参考修改；</li>
        <li><b>协变量平衡</b>：Table 1 在两组比较时可给出标准化均数差 (SMD)。<b>平台目前不提供倾向评分匹配 (PSM) 或逆概率加权 (IPTW)</b>，如需匹配请在沙箱中自行编写代码并说明方法。</li>
      </ul>

      <h4>9.9 Auto-eCRF 多模态影像与检验指标批量提取与 3D 切片热力图穿梭溯源 (Auto-eCRF & 3D Provenance)</h4>
      <p>减轻科研数据采集中繁重、易错的人工录入，打通“电子病历/检验报告 → 3D DICOM 影像 → 科研数据表”的实时可信溯源通道：</p>
      <ul>
        <li><b>批量智能抽取与字段结构化映射</b>：全自动解析电子病历文本、生化免疫检验单及 3D DICOM 影像元数据，自动映射至符合 CDISC 标准的研究变量（如人口学、LVEF、NT-proBNP、肿瘤长短径）；</li>
        <li><b>影像来源回溯</b>：在研究数据集表格中点击影像特征数值，可打开对应的切片核对来源（平台不提供 Grad-CAM 等模型可解释性热力图）。</li>
      </ul>

      <h4>9.10 临床预后列线图 (Nomogram) 与 ROC/DCA 决策曲线分析（暂未开放）</h4>
      <p>暂未开放：列线图与 ROC / DCA 需要基于本研究真实拟合的预测模型（系数、基线生存率、模型预测概率），平台尚未提供模型拟合流程，界面入口已隐藏。</p>

      <h4>9.11 原生 Word (.docx) Table 1 基线三线表一键导出 (OpenXML Native Word Export)</h4>
      <p>针对传统从网页或统计软件复制表格到 Word 导致格式错位、线宽不一、中英文字体混乱的顽疾，Heurion 采用底层 OpenXML 规范直接生成原生 Word (.docx) 表格：</p>
      <ul>
        <li><b>医学顶刊经典三线表排版</b>：表头上顶线 (1.5pt 实线)、表头下线 (0.75pt 实线)、表底线 (1.5pt 实线)，严格去除任何纵向竖线，中文字体预设为宋体，英文及统计符号预设为 Times New Roman；</li>
        <li><b>统计标注与脚注自适应</b>：自动附带 Shapiro-Wilk 检验正态性说明（<code>Mean ± SD</code> vs <code>Median (IQR)</code>）、显著性检验脚注与多组比较符号标记，可直接插入投稿手稿无需二次格式调整。</li>
      </ul>

      <h4>9.12 一键导出 SCI 投稿出版包 (.zip) (One-Click SCI Publication Bundle)</h4>
      <p>在课题研究空间点击<b>「一键导出 SCI 投稿包」</b>，系统只用本研究真实入组受试者的真实数据打包 <code>.zip</code> 投稿材料草稿。研究没有入组受试者时拒绝导出；缺失值保持缺失、绝不补值；没有数据支撑的图表不生成，并在 README 中说明原因：</p>
      <div class="help-feature-card" style="margin: 12px 0;">
        <div class="hfc-title">${icon('download', { size: 14 })} 投稿材料包文件清单（视数据生成）</div>
        <div class="hfc-desc">
          <table class="help-table" style="margin: 6px 0;">
            <thead>
              <tr style="border-bottom: 1px solid var(--line); background: var(--card-glass);">
                <th>文件</th>
                <th>生成条件</th>
                <th>内容说明</th>
              </tr>
            </thead>
            <tbody>
              <tr><td><code>Table1_Baseline_Characteristics.docx</code></td><td>总是生成</td><td>Word 三线表；受试者记录了至少 2 个治疗分组时做组间比较，否则只做总体描述；每个变量列出缺失数</td></tr>
              <tr><td><code>Figure1_Participant_Flow.svg</code></td><td>总是生成</td><td>只含平台入组记录：入组 → 移出 / 无权限未导出 → 纳入分析 → 各组人数；平台没有筛选与排除记录，不绘制该环节</td></tr>
              <tr><td><code>Figure2_Kaplan_Meier_Survival_Curve.svg</code></td><td>有受试者同时记录随访时间与结局</td><td>KM 曲线与风险表；缺随访时间或结局的受试者被排除，人数写入正文与 README</td></tr>
              <tr><td><code>Figure3_Cox_Forest_Plot.svg</code></td><td>恰有 2 个真实分组且事件数足够</td><td>以分组为唯一变量的未校正 Cox HR</td></tr>
              <tr><td><code>Manuscript_Statistical_Methods_and_Results.md</code></td><td>总是生成</td><td>只描述实际做过的分析，并列出未做的分析及原因</td></tr>
              <tr><td><code>STROBE_Statement_Checklist.md</code></td><td>总是生成</td><td>标明材料包覆盖了哪些条目，其余由作者补充</td></tr>
              <tr><td><code>Statistical_Reproducibility_Script.py</code></td><td>总是生成</td><td>读取导出的分析数据集重算 KM / log-rank / Cox，不内置任何结果</td></tr>
              <tr><td><code>README_Submission_Manifest.txt</code></td><td>总是生成</td><td>文件清单、各变量缺失数、生存分析排除人数与未生成项说明</td></tr>
              <tr><td colspan="3">未做倾向性评分匹配 / 加权，因此不生成 Love Plot；没有为研究拟合预测模型，因此不生成列线图与 ROC / DCA。</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <hr style="border: 0; border-top: 1px dashed var(--line); margin: 24px 0;">

      <h3>9.13 临床科研全流程操作与规范对照矩阵表 (Clinical Research Workflow Matrix)</h3>
      <p>为帮助临床医生与统计师快速掌握全套科研工具，下表梳理了 10 大核心环节的操作入口、核心技术与规范产出：</p>

      <div class="help-feature-card" style="margin: 12px 0; overflow-x: auto;">
        <table class="help-table" style="min-width: 860px;">
          <thead>
            <tr style="border-bottom: 2px solid var(--line); background: var(--card-glass);">
              <th>科研阶段</th>
              <th>工作空间与操作入口</th>
              <th>平台核心算法与技术机制</th>
              <th>医学统计与国际规范</th>
              <th>标准交付成果物 (Deliverables)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>1. 课题立项</b></td>
              <td>研究空间 → <code>＋ 新建研究</code></td>
              <td>PICO 结构化表单引擎、样本量与统计功效前瞻估算器</td>
              <td>CONSORT 声明、STROBE 指南、IRB 伦理批件、ChiCTR/NCT 注册</td>
              <td>结构化研究方案 (Protocol)、预设终点定义、最少样本量估算书</td>
            </tr>
            <tr>
              <td><b>2. 数据治理与 Auto-eCRF</b></td>
              <td>研究空间 → <code>数据集</code> → 上传/提取</td>
              <td>CDISC/SAS/SPSS/Stata 解析、Auto-eCRF 批量提取、3D 切片与热力图穿梭溯源</td>
              <td>零 PHI (Zero-PHI) 个人隐私脱敏准则、MICE 缺失值多重插补规范</td>
              <td>质控合格的列式 Parquet 数据库、清洗日志、可溯源数据字典</td>
            </tr>
            <tr>
              <td><b>3. 队列筛选与 CONSORT</b></td>
              <td>患者空间 → <code>多维高级筛选</code> → 纳入研究</td>
              <td>多维布尔逻辑筛选引擎、影像测量值联动提取 (RECIST 径线等)</td>
              <td>临床纳排标准自动化判定、CONSORT 2010 受试者筛选流程规范</td>
              <td>符合入组条件的候选队列、CONSORT 入选/排除流向图 (Figure 1 矢量图与 Mermaid)</td>
            </tr>
            <tr>
              <td><b>4. 基线平衡与 Table 1</b></td>
              <td>研究空间 → <code>统计分析</code> → Table 1 生成</td>
              <td>Shapiro-Wilk 正态检验、两组标准化均数差 (SMD)、OpenXML 原生导出</td>
              <td>医学期刊常用三线表规范 (Table 1)</td>
              <td>Table 1 原生 Word (.docx) 三线表（两组时含 SMD）</td>
            </tr>
            <tr>
              <td><b>5. 因果推断与混杂偏倚</b></td>
              <td>研究空间 → <code>因果推断</code> → E-value 计算</td>
              <td>VanderWeele E-value 公式（点估计与置信区间界限）</td>
              <td>观察性流行病学因果推断准则、国际顶级期刊审稿人质疑答辩规范</td>
              <td>E-value 结果与中英文结果表述段落</td>
            </tr>
            <tr>
              <td><b>6. 生存分析</b></td>
              <td>研究空间 → <code>统计分析</code> → KM 生存曲线</td>
              <td>Kaplan-Meier 乘积极限法、Log-Rank 渐近假设检验、ARR 与 NNT 算法</td>
              <td>NEJM / Lancet 生存曲线规范、严格对齐的风险人数表 (Number at Risk)</td>
              <td>带 95% 置信带的高清 KM 曲线、中位生存期、Log-Rank 统计检验量 (Figure 3)</td>
            </tr>
            <tr>
              <td><b>7. 预后建模</b></td>
              <td>研究空间 → <code>统计分析</code> → Cox 森林图</td>
              <td>Schoenfeld 残差比例风险检验、多因素逐步 Cox 回归、亚组交互作用检验</td>
              <td>多因素混杂协变量校正准则、预设亚组同质性检验 (\\(P_{\\text{interaction}}\\))</td>
              <td>Adjusted HR 与 95% 置信区间、高清矢量级预设亚组森林图 (Figure 4)</td>
            </tr>
            <tr>
              <td><b>8. 列线图与决策曲线</b></td>
              <td>暂未开放</td>
              <td>—</td>
              <td>—</td>
              <td>需要基于真实拟合的预测模型，平台尚未提供，入口已隐藏</td>
            </tr>
            <tr>
              <td><b>9. 论文发表与数据绑定</b></td>
              <td>写作空间 → 关联研究课题 → 插入图表</td>
              <td>统计结果与文稿数值绑定 (Dynamic Data Binding)、文档渲染引擎</td>
              <td>ICMJE 医学期刊投稿标准、CONSORT 声明、Word (.docx) / PPTX 无损导出</td>
              <td>符合顶刊发表标准的研究论文初稿、学术汇报投影幻灯片、完整可复现 Python 脚本</td>
            </tr>
            <tr>
              <td><b>10. SCI 投稿包全量交付</b></td>
              <td>研究空间 → <code>导出 SCI 投稿包</code></td>
              <td>只用真实入组受试者数据，缺失不补，无数据支撑的图表不生成</td>
              <td>国际主流医学出版商 (Elsevier, Springer Nature, Wiley) 稿件包格式标准</td>
              <td>Table 1、受试者流向图、视数据生成的 KM / Cox 图、方法与结果草稿、STROBE 覆盖清单、复现脚本与 README 的 .zip 包</td>
            </tr>
          </tbody>
        </table>
      </div>
    `
  },
  {
    id: 'collaboration',
    title: '科室协作与知家家庭健康空间 (PHR)',
    badge: '协作共享',
    icon: icon('users', { size: 16 }),
    summary: '科室诊疗组 RBAC 权限矩阵、个人专属知家家庭健康档案、患者安全扫码分享令牌及防泄密管控。',
    contentHtml: `
      <div class="help-section-head">
        <h3>10. 科室协作与知家家庭健康空间 (Collaboration & PHR)</h3>
        <span class="help-tag">权限矩阵 · 家人健康</span>
      </div>
      <p class="help-lead">兼顾院内科室团队高效协作与医生个人家庭健康管理，双重身份安全解耦。</p>

      <h4>10.1 科室团队与诊疗组 (Care Team)</h4>
      <ul>
        <li><b>角色分工</b>：机构管理员 (Admin)、主管医师 (Attending Physician)、辅助医师 (Fellow/Resident)。</li>
        <li><b>数据可见性</b>：不同医疗组之间实行患者病历权限隔离，确保诊疗隐私与数据追溯责任到人。</li>
      </ul>

      <h4>10.2 知家 (Personal Health Record, PHR) · 个人专属家庭空间</h4>
      <p>在右上角账户菜单点击「个人空间 (知家)」，即可切换至独立个人档案：</p>
      <ul>
        <li><b>物理级隔离</b>：知家属于医生个人空间，与医院工作台完全物理隔离。即使未来更换执业医院，知家中的家人体检报告、化验单及慢病指标永不丢失。</li>
        <li><b>AI 亲情化解读</b>：利用通俗易懂的语言对长辈体检异常指标进行科普化分析与随访建议。</li>
      </ul>

      <h4>10.3 患者随访与安全扫码分享</h4>
      <p>医生可为特定患者生成具有有效期的<b>外部安全访问令牌 (Secure Share Token)</b>：</p>
      <ul>
        <li>患者在微信或移动端浏览器打开，仅能查阅经过去标识化的通俗化报告与趋势图，无法看到医生内部工作流与其他患者数据。</li>
        <li>支持随时一键作废已发放的分享链接。</li>
      </ul>

      <h4>10.4 临床排期日历与医疗科研邮箱一体化系统 (Clinical Calendar & Medical Mailbox)</h4>
      <p>为方便管理临床随访与科研节点，Heurion 深度集成了<b>原生医疗日历</b>与 <b>@heurion.org 专属科研邮箱</b>：</p>
      <ul>
        <li><b>统一医生专属工作邮箱 (@heurion.org)</b>：每位注册医生拥有专属身份标识（如 <code>wang@heurion.org</code> 或 <code>hz@heurion.org</code>）；随访高危复查专函 (<code>followup@heurion.org</code>) 自动推送；科研通知由 <code>research@heurion.org</code> 发送。</li>
        <li><b>患者随访复查智能排期 (Follow-up Scheduling)</b>：支持将随访方案按指南转化为精确排期（如按方案设定的复查间隔生成排期）。</li>
        <li><b>跨空间闭环联动通道</b>：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」、日程新建支持一键勾选同步向 @heurion.org 邮箱发送通知。</li>
      </ul>
    `
  },
  {
    id: 'citations',
    title: '引用文献真伪校验与学术论断核验',
    badge: '循证质控 · 独家机制',
    icon: icon('sparkles', { size: 16 }),
    summary: '权威官方 API 检索与写屏障拦截、PMC 开放获取全文与结构化表格 (RCT Tables) 抽取、命题级论断核查、一键采纳正文纠错建议与专家临床经验豁免。',
    contentHtml: `
      <div class="help-section-head">
        <h3>11. 引用文献真伪校验与学术论断核验 (Reference Verification & Claims Validation)</h3>
        <span class="help-tag ok">全链路保真 · PMC 表格抽取 · 一键纠错 · 经验豁免</span>
      </div>
      <p class="help-lead">解决传统大模型医学写作中普遍存在的「虚假引用」、「张冠李戴」与「数据脱节」致命痛点，构建从权威数据库检索、PMC 开放获取全文与结构化表格抽取、命题级因果核对、智能纠错一键采纳到临床经验豁免的全链路闭环。</p>

      <h4>11.1 为什么需要严苛的引用文献与论断核查机制？</h4>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">① 防范大模型「虚构文献」</div>
          <div class="hfc-desc">通用大模型常凭空捏造论文标题、虚构作者与编造不存在的 DOI（所谓 Hallucinated Citations）。在医学科研中，虚构引用属于严重学术不端，需要在写入环节加以拦截。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">② 解决「张冠李戴」断言脱节</div>
          <div class="hfc-desc">AI 引用的文献虽然真实存在，但正文陈述与文献实际结论相反（如将未提前终止的临床试验写为提前终止），或正文引用的统计数字（HR、OR、95% CI、不良反应率）在文献中无据可查。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">③ 破除「摘要信息茧房」与盲区</div>
          <div class="hfc-desc">传统文献检索仅能抓取数百字的摘要（Abstract），而 RCT 关键的亚组分析、主要终点与安全性数据均深藏在全文结构化表格与图注中。核验引擎必须能“看懂表格”。</div>
        </div>
      </div>

      <h4>11.2 第一道防线：全链路权威文献登记与操作层写屏障 (Ground-Truth Registry & Write Barrier)</h4>
      <p>Heurion 不允许在正文中自由手写引用标记，所有引用均受到平台底层的强制保护：</p>
      <ul class="help-list-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <b>权威数据库实时检索校验</b>：在文档或对话中引用文献时，系统通过 NCBI E-utilities (PubMed)、Crossref 及 Europe PMC 官方权威 API 进行实名比对，仅当标题、DOI、发表年份及期刊匹配成功后，方在数据库中登记并下发受信任的平台唯一代币 <code>[@c:citation_id]</code>。
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <b>操作层核心写屏障 (guardCitations)</b>：当 AI 或外部 Agent 尝试对文档写入内容时，底层统一操作层会拦截并逐一检查文本中的所有代币。<b>严禁注入任何未经注册登记的非法代币或裸文本假引用</b>。未登记代币将直接触发拒绝写入并提示医生重新检索，从源头切断虚构文献的滋生土壤。
          </div>
        </li>
      </ul>

      <h4>11.3 第二道防线：PMC XML 开放获取全文与结构化表格/图注深度提取 (PMC XML Mining)</h4>
      <p>当引用的文献属于 PubMed Central (PMC) 或 Europe PMC 开源开放获取 (Open Access) 范围时，Heurion 自动下载并解析其完整的原始 XML 树状结构：</p>
      <div class="help-grid-3">
        <div class="help-feature-card">
          <div class="hfc-title">&lt;table-wrap&gt; 表格深度解析</div>
          <div class="hfc-desc">自动将 XML 中的复杂医学表格（如 Table 1 基线人口学表、终点亚组分析 Hazard Ratios 表、AEs 不良事件统计表）转换为结构化 Markdown 表格，保留行列对齐与表头层级。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">&lt;fig&gt; 图注与因果证据图解</div>
          <div class="hfc-desc">抽取 Kaplan-Meier 生存曲线、森林图、ROC 曲线等图表标题与详细图注 (Caption)，捕获图表中关于在险人数、P 值与分界点的精细描述。</div>
        </div>
        <div class="help-feature-card">
          <div class="hfc-title">多级语义证据切片匹配</div>
          <div class="hfc-desc">在比对特定临床主张时，优先检索正文对应的小节段落、关联表格行与图注，确保核验比对基于最详实的一手数据，而非粗略的摘要推测。</div>
        </div>
      </div>

      <h4>11.4 第三道防线：命题级断言核验与五大裁定标准 (Proposition-level Claims Validation)</h4>
      <p>点击顶部或侧边的<b>「核对论断 (Verify Claims)」</b>或在 AI 对话中触发审查时，系统启动命题级核验引擎：</p>
      <table class="help-table">
        <thead>
          <tr>
            <th>核验判定状态</th>
            <th>判定标识</th>
            <th>临床判定依据与场景说明</th>
            <th>系统处置动作</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>支持 (Supported)</b></td>
            <td><span class="help-tag ok">支持 · 绿标</span></td>
            <td>正文陈述的数值、研究设计或结论与所引文献原文/表格完全自洽吻合。</td>
            <td>核验通过，正文保留绿色微标，不生成警示批注。</td>
          </tr>
          <tr>
            <td><b>不支持 (Unsupported)</b></td>
            <td><span class="help-tag danger">矛盾 · 红标警示</span></td>
            <td>正文陈述与文献实测数据存在显著矛盾（例如：正文写 HR=0.68 但文献实为 0.74，或正文称“试验提前终止”但文献明确“按设计完成全部随访”）。</td>
            <td>在正文对应语句下方渲染红色虚线，右侧自动悬挂「论断核对」批注卡，并输出具体的修改建议。</td>
          </tr>
          <tr>
            <td><b>无法判断 (Unclear)</b></td>
            <td><span class="help-tag warn">存疑 · 黄标提示</span></td>
            <td>文献未开源全文且摘要中未提及该具体细节，或两方陈述存在概念交叠但证据不足以确证。</td>
            <td>生成黄色关注标记，提示医师复核原始文献纸质版或专著。</td>
          </tr>
          <tr>
            <td><b>缺少出处 (Missing Citation)</b></td>
            <td><span class="help-tag warn">缺出处 · 橙标</span></td>
            <td>正文包含明确的临床统计数值主张（如 HR、OR、不良事件率、样本量等），但该句未标注任何引用代币。</td>
            <td>提示该数值主张孤立无援，引导医生补充引用或标为经验。</td>
          </tr>
          <tr>
            <td><b>临床经验豁免 (Exempted)</b></td>
            <td><span class="help-tag">豁免 · 灰绿标</span></td>
            <td>临床医师确认该句为科室临床经验、病房实务观察或指南共识未涵盖的经验性总结，已主动执行豁免。</td>
            <td>永久归档豁免，消除红黄警示，后续核查不再打扰。</td>
          </tr>
        </tbody>
      </table>

      <h4>11.5 第四道防线：AI 智能纠错建议与「一键替换正文」 (One-Click Quick Patch)</h4>
      <p>当判定为 <code>unsupported</code> 时，系统不只抛出报错，而是依据权威文献原文自动生成规范修正文句：</p>
      <ul>
        <li><b>自动提炼修正句</b>：核验引擎在批注中格式化输出 <code>【建议修改为】：&lt;准确文句&gt;</code>（如：将“试验因显著疗效提前终止”精准提炼为“试验按事件驱动设计完成全部随访”）。</li>
        <li><b>一键采纳修复</b>：临床医生无需在长篇大论中手动寻找段落与光标，直接在右侧批注卡片上点击<b>「一键替换正文」</b>按钮，系统通过原子化操作将正文对应锚点精准替换为修正句，批注自动转为解决态，高效闭环。</li>
      </ul>

      <h4>11.6 第五道防线：专家「临床经验豁免」机制 (Clinical Experience Exemption)</h4>
      <p>循证医学并非教条主义。在真实世界的重症救治与疑难杂症处置中，资深医学专家多年的临床直觉、用药微调经验及病房实操规范往往尚未形成发表文献：</p>
      <ul>
        <li><b>尊重临床实操</b>：对于缺少文献出处或因临床观察与经典文献存在微小出入的段落，平台提供<b>「标为临床经验」</b>通道。</li>
        <li><b>物理状态存证</b>：医生点击后，系统在数据库中永久存证该断言的豁免记录 (<code>status: 'exempted'</code>)，既满足学术审查的追溯要求，又避免医生在后续修改保存时被反复打扰。</li>
      </ul>

      <h4>11.7 临床雷达扫描动效与边栏批注交互 (Mantle Radar & Margin Anchors)</h4>
      <p>核验启动时，页面展示现代极客墨绿雷达波脉冲扫描动效 (Radar Wave)，实时反馈文献全文索引与证据链检索进度；核验完毕后，与正文 ProseMirror 物理锚点实现像素级吸附对齐，支持点击卡片平滑滚动定位正文，提供顶级学术科研级审校体验。</p>
    `
  },
  {
    id: 'faq',
    title: '常见问题与临床操作贴士 (FAQ)',
    badge: '疑难解答',
    icon: icon('info', { size: 16 }),
    summary: '影像上传失败排查、切片对齐精度、导出排版微调与临床法律安全边界说明。',
    contentHtml: `
      <div class="help-section-head">
        <h3>12. 常见问题与操作贴士 (FAQ & Troubleshooting)</h3>
        <span class="help-tag warn">避坑指引 · 临床备忘</span>
      </div>

      <div class="help-faq-item">
        <div class="faq-q">Q1: 上传 DICOM 影像时提示分析超时或格式不支持怎么处理？</div>
        <div class="faq-a">
          A: 请确保上传的压缩包内为标准的单个检查序列 (Single Series)。若包含局部定位像 (Scout view) 或多个不同时相序列混杂，请先筛选出单一轴位主序列再行压缩上传。单次上传推荐压缩包体积 &lt; 500MB。
        </div>
      </div>

      <div class="faq-faq-item">
        <div class="faq-q">Q2: 为什么导出的 Word / PPTX 在部分 Windows 设备上字体显示不一致？</div>
        <div class="faq-a">
          A: 在顶部导出菜单中，提供<b>「中文字体」切换开关</b>：Mac 用户可选择苹方/宋体，Windows 用户可点击切换为「微软雅黑/等线」，确保跨平台排版完全一致。
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Q3: 为什么系统提示某些病灶不能用 RECIST 1.1 评估？</div>
        <div class="faq-a">
          A: RECIST 1.1 标准专门针对实体瘤靶病灶长径变化制定。对于支气管扩张粘液栓、肺部炎症浸润等弥漫或不规则良性病变，长径并不能反映吸收情况。这类病变不适用 RECIST 1.1；平台没有经过验证的体积疗效标准，体积变化只作描述性记录，判断由医师完成。
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-q">Q4: 系统的定量结果可以直接作为最终诊断写入官方病历吗？</div>
        <div class="faq-a">
          A: <b>绝对不能直接照搬。</b> Heurion 属于临床决策辅助与科研工作站。根据医疗质量管理规范，所有 AI 量化测量与因果推理均需具有执业资质的影像科或临床医师核对原始图像并签字后，方可作为医疗文书生效。
        </div>
      </div>
    `
  },
  {
    id: 'releasenotes',
    title: '版本发布更新日志 (Release Notes)',
    badge: '更新里程碑',
    icon: icon('sparkles', { size: 16 }),
    summary: '记录 Heurion 从 v2.0 到 v2.7 核心版本演进、临床影像量化、文献论断核验、生物统计、零 PHI 隐私与交互设计里程碑。',
    contentHtml: `
      <div class="help-section-head">
        <h3>13. 版本发布更新日志 (Release Notes & Milestones)</h3>
        <span class="help-tag ok">持续演进 · 循证创新</span>
      </div>
      <p class="help-lead">Heurion 始终秉承「临床医生与科研人员的专业辅助伙伴」定位，每个版本均历经三甲临床专家严苛验证与医学数据安全审查。</p>

      <div class="help-release-card">
        <div class="help-release-badge current">v2.7 Pro (当前最新版本 · 2026年10月)</div>
        <div class="help-release-title">SCI 投稿出版包一键打包、临床预后列线图 Nomogram、ROC/DCA 决策曲线、因果推断 E-value 与 Auto-eCRF 穿梭溯源</div>
        <ul class="help-release-list">
          <li><b>一键导出 SCI 投稿出版包 (.zip) (One-Click SCI Publication Bundle)</b>：只用研究真实入组受试者的数据打包投稿材料草稿（Table 1、受试者流向图、视数据生成的 KM 曲线与 Cox 森林图、方法与结果草稿、STROBE 覆盖清单、复现脚本与 README）；缺失不补，无数据支撑的图表不生成并说明原因。</li>
          <li><b>临床预后列线图与 ROC/DCA（暂未开放）</b>：需要基于真实拟合的预测模型，入口已隐藏。</li>
          <li><b>未测混杂敏感性分析 (VanderWeele E-value)</b>：计算点估计与置信区间界限的 E-value，并生成中英文结果表述段落；平台不提供倾向评分匹配。</li>
          <li><b>CONSORT 2010 入组筛选流向图与 Mermaid 导出</b>：默认流向图只含平台真实入组记录（入组 / 移出 / 在组）；筛选、排除与分组环节由研究者按原始纳排记录填写后生成，支持矢量图与 Mermaid 源码一键复制。</li>
          <li><b>Auto-eCRF 多模态特征提取与影像来源回溯</b>：从病历文本与影像结果中提取科研变量，在数据表中点击数值可回到对应影像切片核对来源。</li>
          <li><b>原生 Word (.docx) Table 1 基线三线表一键导出</b>：基于 OpenXML 规范生成符合国际医学顶级期刊标准的 Table 1 原生 Word 文件，表头上顶线、表头下线与表底线严密排版，中英文双语免调格式。</li>
          <li><b>OmniCanvas / AgentDoc 独立纯净画布微服务架构</b>：将自由画布引擎重构为独立轻量微服务，支持纯净无干扰的多模态因果诊断图解、影像病灶标注与科研证据卡片绘制。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.6 Pro (2026年10月)</div>
        <div class="help-release-title">引用文献权威校验、PMC 全文表格与图注结构化提取、论断核验与一键正文纠错</div>
        <ul class="help-release-list">
          <li><b>PMC 开放获取全文与结构化表格提取 (PMC XML Table & Caption Mining)</b>：突破传统文献仅能抓取摘要的局限，直连 PubMed Central (PMC) 与 Europe PMC 开放获取 XML 树状节点；创新实现 <code>&lt;table-wrap&gt;</code> 表格（基线特征、终点亚组分析、不良事件统计等）与 <code>&lt;fig&gt;</code> 图注的行级结构化抽取与 Markdown 排版保留，便于核对 RCT 表格中的终点数据。</li>
          <li><b>全链路权威文献登记与写屏障 (guardCitations)</b>：所有引用必须经由 PubMed / Crossref / Europe PMC 官方权威 API 检索校验并赋予唯一代币 <code>[@c:xxx]</code>；平台操作层拦截非法代币与裸标注入，降低伪造文献与捏造 DOI 进入正文的风险。</li>
          <li><b>细粒度论断核查引擎 (verify_claims)</b>：自动切分命题级数值主张句（HR、OR、95% CI、p 值、样本量等），对照已登记文献全文段落与 RCT 结构化表格进行深度比对，输出 <code>supported</code> (支持)、<code>unsupported</code> (矛盾)、<code>unclear</code> (存疑)、<code>missing_citation</code> (缺出处) 及 <code>exempted</code> (豁免) 五大权威裁定。</li>
          <li><b>AI 智能纠错建议与「一键替换正文」 (One-Click Quick Patch)</b>：当检测到正文断言与文献矛盾或数值偏差时，AI 自动提炼 <code>【建议修改为】：...</code> 纠正文句；医生可直接在右侧伴随批注卡片上一键采纳，原子化原地更新正文，无需繁琐人工修改。</li>
          <li><b>专家「临床经验豁免」机制 (Clinical Experience Exemption)</b>：针对权威专家的临床主观观察、病房经验总结或规范流程，支持一键「标为临床经验」，永久归档豁免，兼顾严谨循证与真实世界临床灵活性。</li>
          <li><b>Mantle 临床雷达扫描与邮件废纸篓生命周期重构</b>：重构文献核验动效为墨绿科技雷达脉冲扫描交互；重构邮件系统「移入废纸篓 (Trash)」与「彻底永久删除 (Purge)」双层生命周期及空状态体验。</li>
          <li><b>手机浏览器移动端响应式深度适配</b>：对官网首页（中英文版本）针对 iOS / Android 移动端视口进行完整重构，优化抽屉式汉堡菜单、触摸手势友好度与小屏幕排版。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.5 Pro (2026年10月)</div>
        <div class="help-release-title">临床随访排期日历、@heurion.org 专属科研邮箱与跨空间闭环联动</div>
        <ul class="help-release-list">
          <li><b>原生排期日历工作空间 (Calendar Space)</b>：支持月历网格、周视图与议程列表，直观规划靶向药耐药监测、气道三维容积复查及多中心科研评审节点。</li>
          <li><b>专属医疗科研邮箱系统 (Mail Space)</b>：开箱即用 <code>&lt;username&gt;@heurion.org</code> (如 <code>hz@heurion.org</code>) 医生专属邮箱，支持随访提醒与科研通知。</li>
          <li><b>跨空间两翼协同通道</b>：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.4 Pro (2026年10月)</div>
        <div class="help-release-title">3D 影像量化、体成分阈值分析、影像组学与 1.5px 发丝级矢量设计</div>
        <ul class="help-release-list">
          <li><b>L3 层面体成分分析（阈值法，实验）</b>：按 HU 阈值划分肌肉与脂肪，L3 层为启发式选层；缺少身高时不计算 SMI，不给出肌少症结论。</li>
          <li><b>三维影像组学特征提取</b>：计算形状、一阶统计、GLCM、GLRLM 共 46 项特征，可存入研究数据集；尚未与 IBSI 参考值做一致性校验。</li>
          <li><b>双期差分图与形变配准（实验）</b>：差分图为插值到同一网格后逐体素相减（不含配准）；形变配准为基于强度梯度的迭代位移场方法，未经基准验证。</li>
          <li><b>PET-CT 融合（实验）</b>：使用真实 CT 与 PET（同网格、PET 须已是 SUV、须给 ROI 或生理性摄取排除说明），给出 SUV 统计与伪彩叠加图。</li>
          <li><b>放疗靶区外扩（实验）</b>：在医生提供的 GTV 掩膜上外扩生成 CTV/PTV 并输出关键层图片；不导出 DICOM RT-STRUCT 文件。</li>
          <li><b>发丝级矢量图标系统 (1.5px Hairline SVG)</b>：全面移除杂乱 Emoji，全平台统一换装 1.5px 极简医学科技矢量图标系统；三核心空间顺序调整为「患者 -> 研究 -> 写作」，顺应真实临床医生日常工位逻辑。</li>
          <li><b>多模态影像附件沙箱隔离与上传流程健壮化</b>：支持在对话中直接点击「＋ 上传图片」或拖拽/粘贴超声、CT、胸片、病历截图，后台自动继承沙箱只读权限（0o666/0o777），避免 EACCES 权限冲突；智能引导多模态临床解读并可一键指引至患者影像中心。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.3.0 (2026年8月)</div>
        <div class="help-release-title">MONAI 模型接入、MPR 三正交浏览器与证据清单</div>
        <ul class="help-release-list">
          <li><b>MONAI 模型接入</b>：接入 MONAI Model Zoo 官方权重（脾脏、腹部多器官 SwinUNETR、脑胶质瘤 BraTS、前列腺、心室短轴等），各模型完成度不一，详见第 5.4 节。</li>
          <li><b>诊断级交互式 MPR 三正交切片浏览器</b>：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由十字联动，集成 NiiVue 3D WebGL2 体绘制；支持 5 种标准窗宽窗位一键调窗、病灶质心准星一键定位与切片资产存证。</li>
          <li><b>RECIST 1.1 径线测量</b>：基于分割掩膜测量最长径、垂直方向跨度与体积；疗效分级（CR / PR / SD / PD）由医师判定。</li>
          <li><b>证据清单</b>：按规则清单对照影像结果、化验与病史标签，列出阳性、阴性与缺失项；不是诊断模型。</li>
          <li><b>结构化导出</b>：导出 HL7 FHIR R4 DiagnosticReport JSON 与按 DICOM SR TID 1500 组织的 JSON（非二进制 DICOM 文件）。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.2.0 (2026年6月)</div>
        <div class="help-release-title">自动化临床科研统计、零 PHI 隐私架构与严苛权限隔离</div>
        <ul class="help-release-list">
          <li><b>一站式自动化生物统计引擎</b>：支持上传 SAS/SPSS/Excel 多中心原始数据，自动执行缺失值插补、数据清洗；一键生成符合医学顶级期刊标准的 Table 1 基线特征表、Kaplan-Meier 生存分析曲线（附带 Log-rank p 值与 95% 置信区间）及 Cox 比例风险回归森林图。</li>
          <li><b>零 PHI (Zero-PHI) 临床隐私架构</b>：全流程使用去标识研究代号；医生添加的备注名只保存在本机浏览器 localStorage；上传 DICOM 时清除常见身份标签。</li>
          <li><b>多租户安全沙箱与 AES-256-GCM 隔离</b>：租户级独立密钥加密隔离；敏感操作（删除、高风险编辑）强制弹出红白确认卡拦截并审计留痕。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.1.0 (2026年4月)</div>
        <div class="help-release-title">文档与学术汇报幻灯片双模态无损写作、PubMed 检索与伴随审查</div>
        <ul class="help-release-list">
          <li><b>文档与幻灯片 (Deck) 双模态排版器</b>：原生支持 Word (DOCX)、PPTX、Markdown 双向高保真导入导出，告别格式排版错乱。</li>
          <li><b>伴随式 AI 协作与红绿 Diff 修订机制</b>：AI 输出以高亮修订形式呈现，支持临床医生逐条采纳、修改或驳回，真正落实 Human-in-the-Loop 医疗责任闭环。</li>
          <li><b>PubMed 全球医学文献检索与自动引用溯源</b>：智能匹配并检索 PubMed 权威医学文献，一键生成规范格式参考文献，并在正文中插入关联溯源标记。</li>
          <li><b>Python + Resvg 矢量科研图表生成</b>：工作区内安全执行高精度统计作图脚本，生成 Publication-Ready 矢量级配图。</li>
        </ul>
      </div>

      <div class="help-release-card">
        <div class="help-release-badge">v2.0.0 (2026年2月)</div>
        <div class="help-release-title">Heurion 平台 2.0 全新架构里程碑发布</div>
        <ul class="help-release-list">
          <li><b>全新三栏墨绿极客工作台</b>：现代极简 UI 设计，专为高强度临床与科研工作设计。</li>
          <li><b>知家 (PHR) 个人专属家庭健康空间</b>：与医院科研工作台物理隔离，为医生及家人提供终身健康档案与随访管理。</li>
          <li><b>科室多级诊疗组 (Care Team) 与受控安全分享</b>：支持主管医生与协助医生精细化权限矩阵，兼顾高效协作与数据安全。</li>
        </ul>
      </div>
    `
  }
]

/** 生成一份 Markdown 格式的完整产品手册，供用户一键导入到写作空间作为常驻参考 */
export function buildHelpMarkdown(): string {
  return `# Heurion 临床智能工作站 · 全流程使用手册与操作指南

> **版本**：v2.7 Pro  
> **适用人群**：呼吸科、胸外科、放射影像科、泌尿外科、肿瘤科临床医师与医学科研人员  
> **核心架构**：零 PHI 医学隐私 · MONAI 3D 深度量化 · 引用文献全链路核验 · 临床随访排期日历 · 专属科研邮箱 · 自动化生物统计与 SCI 投稿出版包

---

## 一、 快速上手与界面导览

Heurion 专为临床与医学科研打造，采用三栏自适应现代架构：

1. **左侧导航 Rail & 资源栏**（自上而下顺畅工作流，统一采用 1.5px 极简发丝级医学矢量图标系统）：
   - **患者 (Patients · 临床一线)**：以纯虚拟代号建档，3D 影像深度量化、三正交 MPR 浏览器、双期配准与随访对比；
   - **研究 (Research · 科研转化)**：临床课题立项、多中心数据集质控、Table 1 与生存分析、IBSI 影像组学预后建模；
   - **写作 (Write · 成果输出)**：文档与学术汇报幻灯片、PubMed 引用、红绿 Diff 修订模式与 Word/PPTX 双模态无损导出；
   - **日历 (Calendar · 临床排期)**：门诊随访复查规划、科研课题里程碑审查、学术研讨会，支持月/周/列表多视图与状态跟进；
   - **邮箱 (Mail · 医疗专邮)**：医生专属 \`<username>@heurion.org\` 邮箱，随访高危提醒、科研质控通报，一键直达患者与课题；
   - **资料库 (Library)**：上传医学指南与学术论文，自动向量化供 AI 检索溯源；
   - **回收站与账户中心**：个人设置、机构管理及知家 (PHR) 个人专属家庭健康空间。
2. **中间主工作画布 (Center)**：
   - 富文本编辑器（支持分级标题、公式、表格、PubMed 引用）；
   - 学术汇报幻灯片排版器；
   - 患者 3D MPR 三正交切片交互浏览器；
   - 临床科研数据集管理与透视表。
3. **右侧伴随智能栏 (Side AI)**：
   - 伴随式 AI 对话、红绿 Diff 修订模式（逐条采纳/拒绝）；
   - 学术论文伴随审查与修改建议；
   - 历史版本对比与回滚。

**常用快捷键**：
- \`⌘B\` (粗体)、\`⌘I\` (斜体)、\`⌘U\` (下划线)、\`⌘Z\` (撤销)、\`⌘⇧Z\` (重做)
- \`⌘↩\` (在对话框中快速提交指令)

---

## 二、 医学影像与核心逻辑通俗通识课 (零基础必读)

为了让临床各专科医师、医学科研人员、算法工程师及产品研发团队能在同一语境下无障碍协作，本节用生活化比喻、临床痛点推导及系统技术落地，通俗拆解 15 个核心医学影像与诊断逻辑概念：

### 2.1 常见影像模态能看清什么？(CT vs MRI vs 超声 vs PET-CT)
- **生活化比喻**：
  - **CT (计算机断层扫描)**：像“切西瓜看果肉和西瓜籽”，穿透力强，骨头和高密度硬组织极清；
  - **MRI (磁共振成像)**：像“摇晃体内的水分子听回声”，不发辐射，软组织、大脑神经与韧带边界分辨率极高；
  - **超声 (Ultrasound)**：像“蝙蝠声呐探水下游鱼”，便携无创无辐射，看心脏跳动、血管血液流动等动态器官；
  - **PET-CT (正电子发射断层成像)**：像“给饥饿的癌细胞喂荧光白糖”，肿瘤细胞代谢旺盛疯狂摄取，在漆黑的断层上亮如明灯。
- **为什么需要它**：不同组织物理密度不同，没有任何一种模态可以包打天下。
- **平台系统落地**：支持全模态 DICOM 与 NIfTI 卷解析，并在对话窗口支持直接拖入/粘贴单张超声、CT、胸片截图进行 AI 视觉辅助解读。

### 2.2 为什么叫“体素”？(Voxel vs Pixel)
- **生活化比喻**：屏幕上的“像素 (Pixel)”是一张 2D 扁平彩色贴纸（只有长和宽）；“体素 (Voxel)”是 3D 空间立体乐高积木（拥有真实物理毫米的长、宽、高）。
- **为什么需要它**：CT 切片间距往往不均匀（如切片厚度 5mm，但切片内分辨率 0.7mm），如果直接旋转或拉伸会像压扁的面团严重变形。
- **平台系统落地**：读取影像时保留原始体素间距，长度、面积与体积都按真实物理间距换算，三正交切片按物理比例显示。

### 2.3 亨氏单位 (HU) 与窗宽窗位 (Window Width / Level)
- **生活化比喻**：
  - **HU (Hounsfield Unit, CT值)**：物理密度的温度计。以水为 0 度，空气为 -1000 度，坚硬骨头为 +1000 度；
  - **窗宽窗位 (WW/WL)**：人的肉眼只能辨别几十种灰度，但 CT 值跨越 2000 多度。窗宽窗位就像一副“智能偏光太阳镜”，旋转旋钮就能过滤掉干扰，只看肺泡气道（肺窗）或心脏大血管（纵隔窗）。
- **为什么需要它**：如果只用一套黑白显示，看清了骨头，肺野就会变成一片死黑。
- **平台系统落地**：Heurion MPR 提供预设快捷键：肺窗 (-600/1500)、纵隔窗 (40/400)、腹部窗 (50/350)、骨窗 (300/1500)、脑窗 (40/80)，一键切换无需反复手动拖动。

### 2.4 MPR 三正交切片联动 (Axial / Coronal / Sagittal)
- **生活化比喻**：像一把激光刀切吐司面包：
  - **横断面 (Axial)**：从头到脚横着一层层切（俯视图）；
  - **冠状面 (Coronal)**：从前胸到后背竖着切（正视图）；
  - **矢状面 (Sagittal)**：从左耳到右耳侧着切（侧视图）。
- **为什么需要它**：血管和气道在三维人体中曲折蜿蜒，单张二维切片容易把斜切的管道误判为结节或肿瘤。
- **平台系统落地**：三正交切片同屏十字准星联动，点击「定位病灶中心」，准星自动飞跃到病灶最大几何截面。

### 2.5 印戒征与支气管-伴行动脉比 (BAR)
- **生活化比喻**：在肺野深处，支气管像空心水管，旁边紧贴着供血实心血管，宛如一对形影不离的伴侣（血管是宝石，支气管是细指环）。正常时指环比宝石小；如果支气管发炎扩张，变成大指环镶嵌小宝石，就是著名的“印戒征 (Signet Ring Sign)”。
- **为什么需要它**：支气管内径与伴行动脉直径之比 (BAR) 超过 1 是支气管扩张常用的影像学判断依据之一。
- **平台系统落地**：启发式阈值算法尝试在关键层配对支气管与伴行动脉并测量 BAR，配对失败显示「未测得」；未经临床验证，需医师复核。

### 2.6 高密度粘液栓 (HAM)
- **生活化比喻**：普通痰液像稀薄淘米水，CT 值接近水 (0~20 HU)；但在变态反应性疾病中，嗜酸性坏死蛋白、夏科-雷登结晶凝聚脱水，像坚韧的“牙膏泥”，CT 值飙升到 70~120 HU，比胸壁肌肉 (40~50 HU) 还要发白发硬。
- **为什么需要它**：HAM 对变应性支气管肺曲霉病 (ABPA) 有较高的提示价值，但确诊仍需结合化验与临床。
- **平台系统落地**：按 HU 阈值在气道附近标出软组织密度候选区并计算体积与 HU；候选区可能包含血管等结构，需医师复核。

### 2.7 随访配准与差分吸收热力图
- **生活化比喻**：同一位患者隔三个月复查，呼吸深浅不同、胸廓微侧，就像同一块被轻微揉皱拉伸的印花丝巾。3D 弹性配准 (DIR) 是把两块丝巾抚平对齐，然后两层叠放扣除，剩下有差异的部分。
- **为什么需要它**：肉眼逐张肉眼找病灶费时费力且容易漏诊微小吸收或进展。
- **平台系统落地**：两期体数据插值到同一网格后逐体素相减并按阈值着色（绿色 HU 下降、红色 HU 升高）；不含配准，体位和呼吸差异会造成假差异。

### 2.8 实体瘤尺子 RECIST 1.1 的边界与 3D 容积评估
- **生活化比喻**：拿一把直尺量土豆长径很合适（实体瘤），但如果拿直尺去量像树根一样分支蔓延的泥浆（良性支气管粘液栓），长径毫无意义，必须量容积（体积）。
- **为什么需要它**：很多医生容易生搬硬套肿瘤 RECIST 1.1（PR 需长径缩小 ≥ 30%），导致良性病灶无法合理评估。
- **平台系统落地**：基于分割掩膜测量最长径与体积；实体瘤疗效按 RECIST 1.1 由医师判定，非实体瘤病变（如粘液栓）平台只做描述性体积记录。

### 2.9 隐匿性肌少症与 L3 骨骼肌指数 (SMI)
- **生活化比喻**：有些人外观看起来微胖甚至超重（皮下脂肪厚），但内脏骨骼肌已严重萎缩流失（虚胖/隐匿性恶液质）。
- **为什么需要它**：肌少症患者对大剂量化疗药物、抗真菌药或糖皮质激素的耐受力极差，极易发生严重器官毒性。腰三椎骨 (L3) 横截面的骨骼肌面积是全身肌肉储量的黄金风向标。
- **平台系统落地**：当前体成分分析为 HU 阈值法、L3 层为启发式选层（不是 TotalSegmentator 模型）；缺少身高时不计算 SMI，不给出肌少症结论。

### 2.10 IBSI 国际标准影像组学 (Radiomics)
- **生活化比喻**：人眼看 CT 图像只能分辨粗略的黑白块，而影像组学像用高倍放大镜扫描病灶的微观“数字指纹”，计算灰度粗糙度、异质性、空间纹理排列。
- **为什么需要它**：组学特征可用于探索影像与临床结局之间的关联；相关模型需独立数据验证，不能替代病理与基因检测。
- **平台系统落地**：计算形状、一阶统计、GLCM、GLRLM 共 46 项特征并可存入研究数据集；尚未与 IBSI 参考值做一致性校验。

### 2.11 PET-CT 代谢融合与 SUVmax / MTV / TLG
- **生活化比喻**：CT 告诉你房间的墙壁和家具长什么样（解剖结构）；PET 告诉你房间里的人是不是在疯狂聚会跳舞（代谢活性）。
- **为什么需要它**：良性疤痕也可以在 CT 上表现为大阴影，只有 PET 才能辨别里面究竟是死组织还是活跃癌细胞。
- **平台系统落地**：使用请求给出的真实 CT 与 PET（同网格、PET 须已是 SUV、须给 ROI 或生理性摄取排除说明），给出 SUV 统计与伪彩叠加，不给诊断结论。

### 2.12 放疗电子围栏 RT-STRUCT (GTV / CTV / OAR)
- **生活化比喻**：放疗是用高能射线精准打击肿瘤。GTV 是肉眼可见的敌人堡垒；CTV 是可能潜伏散兵的警戒缓冲圈；OAR (危及器官) 则是绝对不能误伤的平民医院与学校（脊髓、心脏、食管）。
- **为什么需要它**：手工在几百层 CT 上画圈极为耗时，且各医生勾画一致性差。
- **平台系统落地**：只在医生提供的 GTV 掩膜上做 CTV/PTV 几何外扩，不自动勾画 GTV，不导出 DICOM RT-STRUCT 文件，不能用于放疗计划。

### 2.13 多模态因果诊断链
- **生活化比喻**：孤证不立。只看一张 CT 阴影不能轻易下定论；必须像法官判案一样，将“影像学物证（支扩+HAM）+ 实验室生化血液化验（嗜酸粒细胞+总 IgE+曲霉特异抗体）+ 病史主诉”三方铁证串联锁死。
- **为什么需要它**：避免只见树木不见森林造成的误诊误治。
- **平台系统落地**：按规则清单列出影像、化验与病史的阳性 / 阴性 / 缺失项，可导出 FHIR 或 DICOM SR 结构的 JSON；不是诊断模型。

### 2.14 零 PHI 隐私法律底线与本地 localStorage 隔离
- **生活化比喻**：去医院体检，病历上不写真名只写数字胸牌号；但你自己手机备忘录里悄悄记下“这是张阿姨的体检单”。
- **为什么需要它**：医疗数据上云若泄露真实姓名将面临极其严重的法律制裁（HIPAA/GDPR）。
- **平台系统落地**：平台数据库只保存虚拟代号；医生添加的备注名只保存在本机浏览器 localStorage，不发送到服务器数据库。

### 2.15 为什么不能直接拿屏幕像素量病灶？物理体素标定与亚毫米级电子卡尺
- **生活化比喻**：屏幕上的像素点就像手机屏幕上的微型发光灯泡，手机缩放图片时灯泡密度会变化。如果直接拿一把塑料尺在显示器表面量“肿块有 3 厘米长”，在 13 寸笔记本上可能是 3 厘米，在 27 寸大屏上就变成了 6 厘米！这就像拿一根弹性极大的橡皮筋去量布料长短一样荒唐。
- **为什么必须依靠“物理体素标定 (Voxel Spacing)”**：CT 或 MRI 机在扫描患者身体时，会在 DICOM 头文件中严格写入每一个体素在人体三维真实解剖空间中的物理毫米跨度 (如 Pixel Spacing = 0.72 mm/像素，层厚 = 1.0 mm)。系统前端必须实时将鼠标在屏幕上画出的屏幕像素坐标差 $(\Delta x, \Delta y)$，乘以真实的物理标尺常数，才能精准换算为患者体内真实的物理长径与横截面积。
- **平台系统落地**：采用双层 Canvas 交互系统，提供亚毫米级高对比度电子游标卡尺与两点包围盒截面积测量，并将测量线段与原始医学切片进行离屏双层合成无损固化入库。

---

## 三、 医学隐私与安全架构 (Zero-PHI)

1. **零 PHI (Zero Protected Health Information) 强制准则**：
   - **严禁录入真实患者个人敏感信息**（真实姓名、身份证、门诊住院号、手机号）；
   - 统一采用纯研究代号建档（如 \`PT-BRONCHO-001\`、\`SUBJ-002\`）；
   - 上传 DICOM 影像前自动清洗私有敏感 Tag。
2. **AES-256-GCM 租户数据密钥隔离**：
   - 机构间数据相互隔离，防止跨机构越权访问。
3. **高风险操作确认卡 (Human-in-the-Loop)**：
   - 不可逆操作（如删除病历、覆盖数据、下发报告）必须由执业医师主动点击二次确认卡方才生效。
4. **敏感访问审计日志 (Audit Logging)**：
   - 记录人员、时间戳与脱敏病历 ID，满足行业合规要求。

---

## 四、 医学写作与文献溯源

1. **文档与幻灯片双模态**：
   - 支持起草 SCI 论文、综述、病例报告及学术汇报幻灯片；
   - 无损双向导入导出：支持导入/导出 Word (\`.docx\`)、PowerPoint (\`.pptx\`) 及 Markdown (\`.md\`)。
2. **AI 修订模式 (Diff Mode)**：
   - 开启修订模式，AI 的所有润色与增删以红绿 Diff 呈现，由医师逐条审阅采纳。
3. **PubMed 智能引用与资料库检索**：
   - 输入 DOI 或 PMID，自动获取文献元数据并按规范格式插入序号标注与参考文献表；
   - 资料库可上传指南 PDF，AI 对话时勾选「＋ 引用资料」，精准回答并指出出处页码。
4. **高清矢量图表无损导出**：
   - 基于 Python 绘制医学图表，采用 Resvg 矢量渲染引擎与 DrawingML 双模嵌入，导出 Word/PPT 时保持矢量清晰。

---

## 五、 患者管理与 3D 影像量化分析

0. **影像智能分析全流程业务闭环 (The Complete 9-Step Imaging Pipeline)**：
   - ① **影像摄入与脱敏**：DICOM 序列/NIfTI 体数据上传，上传 DICOM 时清除常见身份标签；也可在对话中上传单张截图请 AI 辅助描述（不构成诊断）；
   - ② **空间几何**：统一到 LPS 方向并保留原始体素间距；提供肺窗、纵隔窗、腹部窗、骨窗及脑窗预设；
   - ③ **MONAI 模型与量化算法**：接入多款官方权重与若干阈值法算法，完成度不一，模型类型与可用状态以模型列表为准（详见第 4 项与第八章）；
   - ④ **影像组学特征**：从病灶 ROI 计算 46 项特征（形状、一阶统计、GLCM、GLRLM），尚未与 IBSI 参考值做一致性校验；
   - ⑤ **MPR 三正交交互式切片**：Axial/Coronal/Sagittal 自由十字丝联动；5cm 物理标尺，病灶质心准星一键定位与关键切片资产存证；
   - ⑥ **纵向随访与差分图**：两期差分图（不含配准）与实验性形变配准，双视窗同步滚动比对；
   - ⑦ **PET-CT 融合（实验）**：使用真实 CT 与 PET（同网格、PET 须已是 SUV、须给 ROI 或生理性摄取排除说明），给出 SUV 统计；
   - ⑧ **放疗靶区外扩（实验）**：在医生提供的 GTV 掩膜上外扩 CTV/PTV，不自动勾画 GTV，不导出 DICOM RT-STRUCT 文件；
   - ⑨ **证据清单与结构化导出**：按规则清单列出阳性 / 阴性 / 缺失项；可导出 FHIR 或 DICOM SR 结构的 JSON。
1. **患者全流程档案与零 PHI 准则**：
   - **纯虚拟代号建档**：采用 \`PT-BRONCHO-001\` 等去标识化代号建档；
   - **本机浏览器备注名物理隔离**：医生添加的备注名只保存在本机浏览器的 \`localStorage\` 中，不发送到服务器数据库；
   - **多维档案标签页**：涵盖概览 (Overview)、多期化验 (Labs)、报告原件与影像 (Records)、AI 抽取核对待确认卡 (Review) 及团队协作/破窗访问。
2. **多模态实验室检验指标追踪**：
   - 追踪嗜酸性粒细胞 (Eos)、血清总 IgE、烟曲霉特异性 sIgE、肿瘤标志物 (CEA/CYFRA21-1/NSE/PSA) 及感染生化指标；
   - **国际标准单位自动换算**：跨机构单位自动归一化，支持纵向演变趋势图与检验单原件一键定位溯源。
3. **3D 原始影像支持与全模态覆盖**：
   - 支持 DICOM 序列压缩包 (\`.zip\` / \`.tar.gz\`)、单张 DICOM (\`.dcm\`) 及 NIfTI 卷 (\`.nii\` / \`.nii.gz\`)；
   - 全模态覆盖：高分辨率薄层 CT (HRCT)、磁共振 MRI (T1/T2/FLAIR/DWI/mpMRI)、超声声像图 (Ultrasound)、胸部 X 线平片 (DR/CR) 及 PET-CT 跨模态代谢显像；
   - 自动解析体素空间几何间距 (Voxel Spacing) 与矩阵维度，入库前清除常见身份标签。
4. **MONAI 模型与量化算法现状**（各项完成度不一，输出仅供科研参考）：
   - **模型类型**：模型列表按影像服务返回的类型标注「深度学习 / 定量 CT / 规则算法」，不可用的模型显示原因（调用时返回 501）；
   - **深度学习**：脾脏分割、BTCV 腹部 13 类器官分割（「胰腺 / 双肾 / 肝脏」选项即 BTCV 对应类别，只给器官体积，不识别病灶）、前列腺分带、BraTS、心室短轴单期相分割、全身 104 类结构分割等，以列表中的可用状态为准；
   - **规则算法 / 定量 CT**：支气管-动脉径比与粘液栓容积、肺结节候选、L3 体成分（不判定肌少症）、椎体 ROI 平均 CT 值、交互式区域生长；肺气肿 LAA-950%（不做 GOLD 分级）；
   - **已下线 / 未实现**：冠脉钙化积分（已下线）、病毒性肺炎、气道树、肺叶、脑梗死、颅内出血（未实现，不提供入口）。
5. **诊断级交互式 MPR 三正交切片浏览器**：
   - **双引擎随心切换**：轻量极速 2D 正交切片引擎（内置 5cm 毫米标尺与 HUD 抬头显示）与 NiiVue 3D WebGL2 引擎（3D 体绘制与四视图联动）；
   - **三正交解剖平面自由切换**：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由切换，切片滑动条、鼠标滚轮上下滑动或键盘方向键平滑逐层浏览；
   - **全模态临床窗宽窗位快捷预设**：肺窗 (-600/1500)、纵隔窗 (40/400)、腹部窗 (50/350)、骨窗 (300/1500)、脑窗 (40/80) 及鼠标拖拽无级微调；
   - **三维准星与智能病灶导航**：点击「定位病灶中心」瞬时跳转到病灶最大截面层，实时展示病灶受累标签；
   - **关键截面存证截图 (Capture Snapshot)**：一键转存为平台永久图像资产并生成 Markdown 引用代码，支持一键出具规范影像报告草案。
6. **诊断级 3D MPR 前端轻量标注与卡尺交互量化系统 (Frontend Lightweight Annotation & Caliper Engine)**：
   - **功能设计**：
     - **浏览模式 (Browse)**：默认交互模式，滚轮/滑动条平滑滚动，十字准星实时联动三正交平面；
     - **游标卡尺测距 (Caliper mm)**：拖拽生成抗混叠高反差翡翠绿测量线段，两端绘制 8px 垂直阻挡游标卡脚，中央悬浮暗黑 HUD 气泡读数，直观呈现亚毫米物理长度 (如 \`24.0 mm\`)；
     - **矩形剖面 ROI 面积 (ROI Area)**：两点对角线绘制半透明包围盒，自适应测算物理横截面积 (\`mm²\` 或 \`cm²\`)；
     - **清除标注 (Clear)**：一键擦除当前切片手工测量轨迹，恢复纯净浏览；
     - **双图层复合无损存证 (Composite Snapshot Export)**：离屏 Canvas 将底层原始灰阶切片与顶层卡尺标注复合渲染为高保真 PNG，固化为平台不可篡改的永久医学图像资产，并生成 Markdown 引用代码；
     - **自动化诊断报告草案动态注入**：实测长短径与截面积自动追加注入至影像所见段落，形成 Human-in-the-Loop 责任闭环。
   - **交互实现架构**：
     - **双层 Canvas DOM 覆盖**：底层 \`<img id="mprImg">\` (512×512) 渲染影像，顶层覆盖绝对定位的 \`<canvas id="mprAnnotCanvas" width="512" height="512">\`；CSS \`pointer-events\` 精准控制交互穿透；
     - **事件驱动状态机**：\`pointerdown\` 锁定几何原点与激活工具；\`pointermove\` 结合 \`requestAnimationFrame\` 驱动双缓冲平滑局部重绘；\`pointerup\` 固化几何终点并保存测量元数据；
     - **视网膜高清屏 (Retina Display) 锐化适配**：依据 \`window.devicePixelRatio\` 动态调整绘图缓冲区物理尺寸，减少高分屏锯齿与模糊；
     - **人机工程学高反差视觉**：翡翠绿主线 (#00E599 / #34D399)、半透明深色 HUD 气泡 (\`rgba(6, 17, 13, 0.85)\`)，在黑白骨软组织背景下始终清晰可辨。
   - **算法量化原理与物理标定**：
     - **空间体素间距提取**：DICOM Pixel Spacing $S_x, S_y$ (mm/px)；
     - **画布坐标步长归一**：$k_x = \\frac{\\text{dim}_x \\times S_x}{512}, \\quad k_y = \\frac{\\text{dim}_y \\times S_y}{512}$；
     - **真实物理欧氏距离**：$D_{\\text{mm}} = \\sqrt{[(\\Delta x) \\cdot k_x]^2 + [(\\Delta y) \\cdot k_y]^2}$，无缝对齐 RECIST 1.1 靶病灶长短径；
     - **剖面截面积自适应**：$A_{\\text{mm}^2} = (|\\Delta x| \\cdot k_x) \\times (|\\Delta y| \\cdot k_y)$，当 $A \\ge 100 \\text{ mm}^2$ 自动折算 $A_{\\text{cm}^2} = A / 100$；
     - **离屏双层合成固化**：$\\text{CompositeCanvas} = \\text{DrawImage}(\\text{Slice}) + \\text{DrawImage}(\\text{Canvas})$，Base64 PNG 写入平台存证数据库。
7. **L3 层面体成分分析（阈值法，实验）**：
   - 按 HU 阈值划分骨骼肌、内脏脂肪与皮下脂肪，L3 层为启发式选层（不是 TotalSegmentator 模型）；缺少身高时不计算 SMI，平台不给出肌少症结论。
8. **影像组学特征提取**：
   - 计算形状、一阶统计、GLCM、GLRLM 共 46 项特征并可存入研究数据集；尚未与 IBSI 参考值做一致性校验，不含 GLSZM、NGTDM 与小波特征。
9. **影像报告草稿**：
   - 汇总检查参数、算法测量值、关键切片与证据清单生成草稿，需医师审阅修改。

---

## 六、 双期对比、差分图与配准（实验功能）

1. **双期差分图**：把随访体数据插值到基线网格后逐体素相减，按 HU 阈值（默认 50 HU）叠加显示，绿色为 HU 下降、红色为 HU 升高；差分图本身不做配准，体位与呼吸差异会造成假差异，不能直接解读为吸收或进展。
2. **形变配准（实验）**：\`registration.run_3d_deformable_registration\` 用基于强度梯度的迭代位移场对齐两期体数据，报告配准前后 NCC、均方误差降幅与最大位移；未在公开基准上验证。
3. **双视窗同步滚动**：勾选「锁定同步滚动」后两侧按层号相对比例同步翻页（不是按配准后的解剖位置对应）。
4. **PET-CT 融合与放疗靶区外扩（实验）**：使用请求给出的真实影像；PET-CT 要求同网格、PET 已是 SUV、提供 ROI 或生理性摄取排除说明；靶区外扩必须提供 GTV 掩膜；输出 SUV 统计、CTV/PTV 外扩结果和关键层图片，**不导出 DICOM RT-STRUCT 文件**。
5. **疗效评估标准**：实体瘤按 RECIST 1.1（PR 缩小 ≥ 30%；PD 增大 ≥ 20% 且绝对值增加 ≥ 5 mm），判定由医师完成；粘液栓等非实体瘤病变不适用 RECIST，平台没有经过验证的体积疗效标准，体积变化只作描述性记录。

---

## 七、 证据清单与标准格式导出

1. **证据清单**：根据影像记录类型选择规则清单，逐项对照已录入的化验指标与病史标签，标记阳性 / 阴性 / 缺失并列出待查项；这是固定条目匹配，不是诊断模型，结论由医师给出。
2. **报告草稿**：汇总检查参数、算法测量值、关键切片与清单结果，需医师审阅修改。
3. **结构化导出**：HL7 FHIR R4 DiagnosticReport JSON；DICOM SR 为按 TID 1500 组织的 JSON 表示，不是二进制 DICOM 文件，不能直接导入 PACS。

---

## 八、 【算法演示】公开数据集上的影像算法输出

本章图片全部由 \`scripts/generate_all_case_study_images.py\` 在 \`apps/imaging-worker/data/\` 的公开数据集样本上实际运行平台算法生成，图上每一个分割轮廓、测量卡尺和数值都来自计算结果。体数据统一转换到 LPS 方向后渲染：轴位图上方为前、图像左侧为患者右。**这些都是公开数据集上的算法输出演示，不是临床病例，也不构成诊断意见。**

### 8.0 本章未收录的内容及原因

- **疗效差分热力图 / 随访对比**：需要同一受试者的两次扫描，公开样本中没有；
- **L3 体成分与骨骼肌指数 (SMI)**：当前实现为 HU 阈值法、L3 层为启发式选层，且公开样本没有身高数据，无法计算 SMI；
- **前列腺 MRI 分区**：MONAI 前列腺权重在现有样本上没有得到有效分割；
- **支气管扩张与粘液栓定量**：现有实现为启发式阈值法，在示例样本上的关键层落在肺门，候选区可能是血管或淋巴结；
- **病理、分期、基因、化验与治疗经过**：公开影像样本不含这些信息，本章不做此类描述。

### 8.1 MONAI 3D-UNet 脾脏自动分割与体积测量

- 图片：[公开腹部 CT 样本上的 MONAI 脾脏分割结果](/site/demo-spleen-monai-segmentation.png)

- **数据**：公开数据集样本 \`spleen_test\`（腹部 CT，体素 0.703×0.703×5.0 mm）；
- **算法**：MONAI 官方 spleen_ct 3D-UNet 权重滑窗推理，随后用 \`recist.calculate_recist_metrics\` 计算体积与最大截面最长径；
- **本次结果**：分割 51,737 个体素，体积 127.89 cm³；最大截面在第 76 层，最长径 87.8 mm。

### 8.2 三正交多平面重建 (MPR)

- 图片：[公开胸部 CT 样本的轴位、冠状位、矢状位重建](/site/demo-chest-mpr-3view.png)

- **数据**：公开数据集样本 \`chest_lung_ct\`（胸部 CT，体素 0.898×0.898×1.25 mm）；
- **处理**：统一到 LPS 方向后直接取三个正交平面，按物理间距等比例显示，未做病灶标注；十字定位在体数据几何中心。

### 8.3 肺结节 RECIST 1.1 径线与体积测量

- 图片：[公开胸部 CT 样本上的肺结节 RECIST 测量](/site/demo-lidc-nodule-recist.png)

- **数据**：公开数据集样本 \`lidc_lung_nodule_ct\`，ROI 使用样本附带的结节标注掩膜，不是平台自动分割的结果；
- **算法**：\`recist.calculate_recist_metrics\` 选最大截面层，经凸包求最长径并计算垂直方向最大跨度与三维体积；
- **本次结果**：关键层第 89 层，最长径 31.2 mm，垂直方向最大跨度 26.2 mm，体积 7.47 cm³；只有一个时间点，不涉及疗效评估。

### 8.4 三维影像组学特征提取

- 图片：[公开胸部 CT 样本肺结节的影像组学特征节选](/site/demo-lidc-nodule-radiomics.png)

- **数据**：与 8.3 相同的 ROI；
- **算法**：\`radiomics.extract_radiomics_features\`，计算三维形状 15 项、一阶统计 18 项、GLCM 6 项、GLRLM 7 项，共 46 项；
- **本次结果（节选）**：体积 7.466 cm³，球形度 0.5287，均值 −141.08 HU；
- **局限**：该实现尚未与 IBSI 参考数据集或 PyRadiomics 做一致性校验。

---

## 九、 临床科研工作流 (Research)

覆盖临床研究方案拟定、多源多格式数据表质控导入、零 PHI 敏感数据脱敏、患者库智能入组、受限沙箱生物统计学制表及文章发表归档全周期。

### 9.1 核心功能与操作指南
1. **科研立项与方案起草 (Protocol Design & Registry)**：
   - 结构化录入研究代号 (如 \`ST-HFREF-2026-001\`)、中英文全称、PI、机构伦理审查批件号 (IRB) 与临床试验登记号 (ChiCTR / ClinicalTrials.gov NCT ID)；
   - 依据 PICO 框架结构化输入目标人群 (Population)、干预措施 (Intervention)、对照方案 (Comparator) 与主要/次要终点事件 (Outcome)；
   - 内置临床样本量与统计功效估算器 (Power & Sample Size Calculator)，依据预期 HR、$\\alpha$ 与统计功效估算最少样本量与事件数。
2. **多格式数据集质控导入与零 PHI 敏感数据脱敏**：
   - 原生支持 CSV、Excel (\`.xlsx\`/\`.xls\`)、SAS (\`.sas7bdat\`)、SPSS (\`.sav\`) 及 Stata (\`.dta\`)；
   - 自动推断变量字典，解析连续、二分类、多分类及生存结局字段，映射 SAS/SPSS 值标签 (Value Labels)；
   - 前端沙箱执行零 PHI (Zero-PHI) 严格审查，自动拦截姓名、身份证号、电话与住院号，映射为虚拟受试者编号 (\`S001~Sn\`)，研究数据集中只保留研究编号；
   - 缺失率梯级评估与 3-Sigma / IQR 离群极端值智能标红预警，支持 MICE 多重插补。
3. **患者库多维条件筛选入组与动态队列生成**：
   - 打通患者中心与科研中心，支持基于 ICD-10 诊断、化验指标范围及 3D 影像表型（如 LVEF、RECIST 径线）多维布尔逻辑筛选；
   - 实时预览入组候选人分布，一键生成隔离受控列式 Parquet 研究数据集。
4. **受限隔离沙箱自动化医学统计分析**：
   - **Table 1 基线特征三线表**：正态分布 (Mean±SD, t 检验) / 偏态分布 (Median(IQR), Wilcoxon 检验) / 分类变量 (N(%), 卡方/Fisher 确切概率法) 自动检验并选用；两组比较时可计算标准化均数差 (SMD)，平台不提供倾向评分匹配 (PSM)；
   - **Kaplan-Meier 生存曲线**：绘制带 95% 置信区间的生存概率曲线，计算中位生存时间 (Median OS/PFS)，执行 Log-Rank 假设检验，底部严格对齐输出风险人数表 (Number at Risk Table)；
   - **Cox 比例风险回归与亚组森林图**：检验比例风险假定，执行多因素回归校正混杂协变量，输出校正风险比 (Adjusted HR) 及 95% CI，自动生成带交互作用 P 值 ($P_{\\text{interaction}}$) 的高清亚组森林图；
   - **完全透明开源**：底层调用 \`scipy\`、\`statsmodels\`、\`lifelines\` 标准 Python 统计库，每张图表附带完整底层执行脚本代码，支持一键复制代码与审计。
5. **影像生物标志物生存分析与预后建模**：
   - 将影像测量值（如 RECIST 径线、体积）与 46 项影像组学特征存入队列数据集，参与研究者设定的生存分析。
6. **成果闭环与学术发表**：
   - 写作空间关联研究课题，正文无损嵌入图表与动态统计字段，数据随随访自动联动更新，一键导出发表级 Word (.docx) 手稿与演讲 PPTX。
7. **CONSORT 2010 受试者入组筛选流向图生成 (CONSORT 2010 Flow Diagram & Mermaid)**：
   - 默认只画平台真实入组记录（入组 / 移出 / 在组）；筛选、排除与分组人数由研究者按原始纳排记录填写，平台不估算；
   - 支持一键导出 Publication-Ready 高清矢量图 (SVG / 300+ DPI PNG) 及标准 \`Mermaid.js\` 流程图源码复制。
8. **未测混杂敏感性分析 (VanderWeele E-value)**：
   - 按 VanderWeele & Ding (2017) 公式计算点估计与置信区间界限的 E-value；
   - 生成中英文结果表述段落，供作者回复审稿意见时参考修改；
   - Table 1 两组比较时可给出 SMD；平台不提供倾向评分匹配 (PSM) 或逆概率加权。
9. **Auto-eCRF 多模态影像与检验指标批量提取与 3D 切片热力图穿梭溯源**：
   - 批量从病历文本、生化化验与 3D DICOM 中抽取 CDISC 标准指标；
   - 数据表中点击影像特征数值，可回到对应的影像切片核对来源。
10. **临床预后列线图 (Nomogram) 与 ROC/DCA 决策曲线分析（暂未开放）**：
    - 暂未开放：列线图与 ROC / DCA 需要基于本研究真实拟合的预测模型（系数、基线生存率、模型预测概率），平台尚未提供模型拟合流程，界面入口已隐藏。
11. **原生 Word (.docx) Table 1 基线三线表一键导出**：
    - 基于 OpenXML 标准直接输出原生 Word 三线表（1.5pt 表头顶线、0.75pt 表头下线、1.5pt 表底线，无纵向竖线）；
    - 中文宋体、英文 Times New Roman，中英文双语自适应，下载即可直接插入投稿手稿。
12. **一键导出 SCI 投稿出版包 (.zip) (One-Click SCI Publication Bundle)**：
    - 只用研究真实入组受试者的数据打包投稿材料草稿（Table 1、受试者流向图、视数据生成的 KM 曲线与 Cox 森林图、方法与结果草稿、STROBE 覆盖清单、复现脚本与 README）；缺失不补，无数据支撑的图表不生成并说明原因。

---

### 9.2 临床科研全流程操作与规范对照矩阵表
| 科研阶段 | 工作空间与操作入口 | 平台核心算法与技术机制 | 医学统计与国际规范 | 标准交付成果物 (Deliverables) |
| :--- | :--- | :--- | :--- | :--- |
| **1. 课题立项** | 研究空间 → \`＋ 新建研究\` | PICO 结构化表单引擎、样本量与功效估算器 | CONSORT、STROBE、IRB 伦理批件、ChiCTR/NCT 注册 | 结构化方案、终点定义、最少样本量估算书 |
| **2. 数据治理与 Auto-eCRF** | 研究空间 → \`数据集\` → 上传/提取 | CDISC/SAS/SPSS 解析、Auto-eCRF 提取、3D 切片与热力图穿梭溯源 | 零 PHI (Zero-PHI) 脱敏、MICE 缺失值多重插补 | 列式 Parquet 库、清洗日志、可溯源数据字典 |
| **3. 队列筛选与 CONSORT** | 患者空间 → \`高级筛选\` → 纳入研究 | 多维布尔筛选引擎、影像测量值联动 (RECIST 径线等) | 临床纳排标准判定、CONSORT 2010 受试者筛选流程规范 | 候选队列预览表、CONSORT 入选/排除流向图 (Figure 1 矢量图与 Mermaid) |
| **4. 基线平衡与 Table 1** | 研究空间 → \`统计分析\` → Table 1 | 正态性检验、两组 SMD、OpenXML 原生导出 | 医学期刊常用 Table 1 三线表规范 | Table 1 原生 Word (.docx) 三线表（两组时含 SMD） |
| **5. 因果推断与混杂偏倚** | 研究空间 → \`因果推断\` → E-value | VanderWeele E-value 公式 | 观察性研究敏感性分析 | E-value 结果与中英文结果表述段落 |
| **6. 生存分析** | 研究空间 → \`统计分析\` → KM 曲线 | Kaplan-Meier 乘积极限法、Log-Rank 检验、ARR/NNT | NEJM/Lancet 生存曲线规范、Number at Risk 风险表 | 带 95% 置信带 KM 曲线、Log-Rank 统计量 (Figure 3) |
| **7. 预后建模** | 研究空间 → \`统计分析\` → Cox 森林图 | Schoenfeld 残差检验、多因素逐步 Cox、亚组交互检验 | 多因素协变量校正、预设亚组同质性检验 ($P_{\\text{interaction}}$) | 校正后 HR 与亚组森林图（按研究数据计算） |
| **8. 列线图与决策曲线** | 暂未开放 | — | — | 需要基于真实拟合的预测模型，平台尚未提供，入口已隐藏 |
| **9. 论文发表与数据绑定** | 写作空间 → 关联课题 → 插入图表 | 统计结果与文稿数值绑定、文档渲染引擎 | ICMJE 投稿标准、Word (.docx) / PPTX 无损导出 | 发表级论文初稿、学术汇报 PPTX、可复现 Python 脚本 |
| **10. SCI 投稿包全量交付** | 研究空间 → \`导出 SCI 投稿包\` | 只用真实入组受试者数据，缺失不补，无数据支撑的图表不生成 | 国际主流医学出版商稿件包格式标准 | Table 1、受试者流向图、视数据生成的 KM / Cox 图、方法与结果草稿、STROBE 覆盖清单、复现脚本与 README 的 .zip 包 |


---

## 十、 科室协作与知家家庭健康空间 (PHR)

1. **科室诊疗组 (Care Team)**：主诊医师与组员权限矩阵，敏感病历访问审计留痕；
2. **知家个人空间 (PHR)**：医生专属家庭健康空间，与医院工作台物理隔离，终身保留家人健康档案；
3. **安全分享与患者沟通**：生成临时有效期的只读脱敏链接，供患者扫码查阅通俗化随访建议。
4. **临床排期日历与医疗科研邮箱一体化系统 (Clinical Calendar & Medical Mailbox)**：
   - **专属医生工作邮箱 (@heurion.org)**：每位注册医生拥有专属身份标识（如 \`<username>@heurion.org\`）；随访专函 (\`followup@heurion.org\`) 自动推送影像量化高危复查提醒；科研通知由 \`research@heurion.org\` 发送。
   - **患者随访复查智能排期 (Follow-up Scheduling)**：支持将随访方案按临床指南推荐时间窗转化为精确排期（如按方案设定的复查间隔生成排期）。
   - **闭环联动通道 (Cross-Space Synergy)**：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」、日程新建同步邮件提醒。

---

## 十一、 引用文献真伪校验与学术论断核验指南 (Reference Verification & Claims Validation)

在医学学术论文起草、循证指南研读及临床科研汇报中，通用大语言模型极易产生**“虚构文献 (Hallucinated Papers)”**、**“伪造 DOI”**、**“文献与论断张冠李戴 (Citation-Claim Mismatch)”**以及**“摘要信息茧房导致 RCT 表格数据缺失”**等致命痛点。Heurion 构建了全链路五道坚实防线，保障每一篇学术文稿的绝对循证严谨性：

### 11.1 全链路真实文献登记与操作层写屏障 (\`guardCitations\`)
1. **权威官方数据库实名检索**：集成 NCBI E-utilities (PubMed)、Crossref 及 Europe PMC 官方权威 API，输入 DOI 或 PMID 后，仅当元数据实名校验通过，方可注册并在平台内分发唯一受信代币 \`[@c:citation_id]\`。
2. **底层操作层核心写屏障**：系统在文档统一操作层严密执行 \`guardCitations\` 守卫，**坚决拦截任何未经登记的伪造代币或直接粘贴的裸文本假引用**，从底层物理阻断大模型虚构文献注入。

### 11.2 PMC XML 开放获取全文与结构化表格提取 (RCT 表格与图注突破)
1. **突破摘要局限**：传统 AI 仅能浏览 200~300 字的摘要，而 RCT 试验的核心关键数据（各亚组分析 Hazard Ratio、95% CI、分层不良反应发生率、两组基线平衡 Table 1）全部深藏在正文表格中。
2. **\`<table-wrap>\` 表格与 \`<fig>\` 图注解析**：直连 PubMed Central / Europe PMC 开放获取 XML 树状节点，将复杂医学表格与图注精准还原为行级结构化 Markdown 表格，使核验引擎能够直接对照 RCT 真实数据表进行证据核验。

### 11.3 细粒度命题级论断核查与五大判定状态 (\`verify_claims\`)
对正文中包含统计数值（HR、OR、95% CI、百分比、样本量、p 值等）及引用代币的句子进行命题级原子切分，对照文献证据库输出五大权威裁定：
- **支持 (Supported · 绿标)**：正文主张与文献原文/表格实测数据完全自洽吻合；
- **不支持 / 矛盾 (Unsupported · 红标警示)**：正文陈述与文献实测数据存在显著矛盾（如数值写反、错误宣称试验提前终止等）；
- **无法判断 (Unclear · 黄标提示)**：文献未开源全文且摘要未提及该细节，提示需人工复核；
- **缺少出处 (Missing Citation · 橙标提示)**：包含具体临床数值结论，但未标注任何参考文献；
- **临床经验豁免 (Exempted · 灰绿标归档)**：经临床医师确认属于病房实践经验，永久豁免警示。

### 11.4 AI 纠错修改建议与「一键替换正文」 (One-Click Quick Patch)
当判定为 \`unsupported\` 时，核验引擎自动解析文献确凿证据并输出 \`【建议修改为】：<纠正后的文句>\`。医师无需在长文中手动翻找光标，直接在右侧批注卡片中点击**「一键替换正文」**，底层原子化执行精确替换，瞬间完成勘误闭环。

### 11.5 专家「临床经验豁免」机制 (Clinical Experience Exemption)
尊重真实世界临床实践的多样性。对于资深专家的临床观察总结、科室常规或病房实践规范，医师可点击卡片上的**「标为临床经验」**，系统在数据库中永久存证该断言的豁免状态 (\`status: 'exempted'\`)，自动归档并消解警示，后续核查不再重复打扰。

### 11.6 临床雷达扫描与批注卡片联动
核验过程中采用墨绿科技雷达波扫描动画展示检索与匹配进度；核验结果与正文锚点实现像素级高精度吸附对齐，红色虚线下划线直观警示，打造沉浸式专业学术审校环境。

---

## 十二、 常见问题解答 (FAQ)

- **Q: 为什么上传 DICOM 耗时较长？**  
  A: 建议上传单个序列的压缩包（< 500MB），去除定位像后再压缩。
- **Q: 为什么生成的报告数值与正文完全自洽？**  
  A: 报告草稿直接引用结构化测量字段，避免模板默认值与实测值不一致；测不到的指标显示「未测得」。
- **Q: AI 输出能直接当作法律效力的病历吗？**  
  A: 不能。所有 AI 辅助结论必须经执业医师审阅核对并签署确认后方可作为正式病历。

---

## 十三、 版本更新日志 (Release Notes)

### v2.7 Pro (当前最新版本 · 2026年10月)
- **一键导出 SCI 投稿出版包 (.zip) (One-Click SCI Publication Bundle)**：只用研究真实入组受试者的数据打包投稿材料草稿（Table 1、受试者流向图、视数据生成的 KM 曲线与 Cox 森林图、方法与结果草稿、STROBE 覆盖清单、复现脚本与 README）；缺失不补，无数据支撑的图表不生成并说明原因。
- **临床预后列线图与 ROC/DCA（暂未开放）**：需要基于真实拟合的预测模型，入口已隐藏。
- **未测混杂敏感性分析 (VanderWeele E-value)**：计算点估计与置信区间界限的 E-value，并生成中英文结果表述段落；平台不提供倾向评分匹配。
- **CONSORT 2010 入组筛选流向图与 Mermaid 导出**：全自动生成标准受试者初筛、排除标准统计、随机化分组及完成随访流程图，支持矢量图与 Mermaid 源码一键复制。
- **Auto-eCRF 多模态特征提取与影像来源回溯**：从病历文本与影像结果中提取科研变量，在数据表中点击数值可回到对应影像切片核对来源。
- **原生 Word (.docx) Table 1 基线三线表一键导出**：基于 OpenXML 规范生成符合国际医学顶级期刊标准的 Table 1 原生 Word 文件，表头上顶线、表头下线与表底线严密排版，中英文双语免调格式。
- **OmniCanvas / AgentDoc 独立纯净画布微服务架构**：将自由画布引擎重构为独立轻量微服务，支持纯净无干扰的多模态因果诊断图解、影像病灶标注与科研证据卡片绘制。

### v2.6 Pro (2026年10月)
- **PMC 开放获取全文与结构化表格提取 (PMC XML Table & Caption Mining)**：突破传统仅抓取摘要局限，深入抓取 PubMed Central / Europe PMC 开放获取 XML 中的 \`<table-wrap>\` 表格与 \`<fig>\` 图注，保留 Markdown 行级对齐排版，便于核对 RCT 表格中的终点数据。
- **全链路权威文献登记与写屏障 (\`guardCitations\`)**：所有引用必须经由 PubMed / Crossref / Europe PMC 官方权威 API 检索注册并赋予唯一代币 \`[@c:xxx]\`；在平台操作层执行写前守卫，拦截未登记的引用、捏造 DOI 与裸标注入。
- **细粒度论断核查引擎 (\`verify_claims\`)**：自动切分命题级数值主张句（HR、OR、95% CI、p 值、样本量等），对照已登记文献全文及 RCT 表格进行深度对照，输出 \`supported\`、\`unsupported\`、\`unclear\`、\`missing_citation\` 及 \`exempted\` 五大权威裁定。
- **AI 智能纠错建议与「一键替换正文」 (One-Click Quick Patch)**：当检测到正文断言与文献矛盾或数值偏差时，AI 自动提炼 \`【建议修改为】：...\` 纠正文句；医生可直接在右侧伴随批注卡片上一键采纳，原子化原地更新正文。
- **专家「临床经验豁免」通道 (Clinical Experience Exemption)**：针对权威专家的临床主观观察、病房经验总结或规范流程，支持一键「标为临床经验」，永久归档豁免，兼顾严谨循证与真实世界临床灵活性。
- **Mantle 临床雷达扫描与邮件废纸篓生命周期重构**：升级文献核验动效为墨绿科技雷达扫描交互；重构邮件系统「移入废纸篓 (Trash)」与「彻底永久删除 (Purge)」双层生命周期及空状态体验。
- **手机浏览器移动端响应式深度适配**：对官网首页（中英文版本）针对 iOS / Android 移动端视口进行完整重构，优化抽屉式汉堡菜单、触摸手势友好度与小屏幕排版。

### v2.5 Pro (2026年10月)
- **原生排期日历工作空间 (Calendar Space)**：支持月历网格、周视图与议程列表，直观规划靶向药耐药监测、气道三维容积复查及多中心科研评审节点。
- **专属医疗科研邮箱系统 (Mail Space)**：开箱即用 \`<username>@heurion.org\` 医生专属邮箱，支持随访提醒与科研通知。
- **跨空间两翼协同通道**：邮件一键「添加到日历」、随访专函直达「患者 3D 影像全景档案」、科研邮件一键直通「科研课题数据集与统计分析沙箱」。

### v2.4 Pro (2026年10月)
- **L3 层面体成分分析（阈值法，实验）**：按 HU 阈值划分肌肉与脂肪，L3 层为启发式选层；缺少身高时不计算 SMI，不给出肌少症结论。
- **三维影像组学特征提取**：计算形状、一阶统计、GLCM、GLRLM 共 46 项特征，可存入研究数据集；尚未与 IBSI 参考值做一致性校验。
- **双期差分图与形变配准（实验）**：差分图为插值到同一网格后逐体素相减（不含配准）；形变配准为基于强度梯度的迭代位移场方法，未经基准验证。
- **PET-CT 融合（实验）**：使用真实 CT 与 PET（同网格、PET 须已是 SUV、须给 ROI 或生理性摄取排除说明），给出 SUV 统计与伪彩叠加图。
- **放疗靶区外扩（实验）**：在医生提供的 GTV 掩膜上外扩生成 CTV/PTV 并输出关键层图片；不导出 DICOM RT-STRUCT 文件。
- **发丝级矢量图标系统 (1.5px Hairline SVG)**：全面移除杂乱 Emoji，全平台统一换装 1.5px 极简医学科技矢量图标系统；三核心空间顺序调整为「患者 -> 研究 -> 写作」，顺应真实临床医生日常工位逻辑。
- **多模态影像附件沙箱隔离与上传流程健壮化**：支持在对话中直接点击「＋ 上传图片」或拖拽/粘贴超声、CT、胸片、病历截图，后台自动继承沙箱只读权限（0o666/0o777），避免 EACCES 权限冲突；智能引导多模态临床解读并可一键指引至患者影像中心。

### v2.3.0 (2026年8月)
- **MONAI 模型接入**：接入 MONAI Model Zoo 官方权重（脾脏、腹部多器官 SwinUNETR、脑胶质瘤 BraTS、前列腺、心室短轴等），各模型完成度不一，详见第 5.4 节。
- **诊断级交互式 MPR 三正交切片浏览器**：横断面 (Axial)、冠状面 (Coronal)、矢状面 (Sagittal) 自由十字联动，集成 NiiVue 3D WebGL2 体绘制；支持 5 种标准窗宽窗位一键调窗、病灶质心准星一键定位与切片资产存证。
- **RECIST 1.1 径线测量**：基于分割掩膜测量最长径、垂直方向跨度与体积；疗效分级（CR / PR / SD / PD）由医师判定。
- **证据清单**：按规则清单对照影像结果、化验与病史标签，列出阳性、阴性与缺失项；不是诊断模型。
- **结构化导出**：导出 HL7 FHIR R4 DiagnosticReport JSON 与按 DICOM SR TID 1500 组织的 JSON（非二进制 DICOM 文件）。

### v2.2.0 (2026年6月)
- **一站式自动化生物统计引擎**：支持上传 SAS/SPSS/Excel 多中心原始数据，自动执行缺失值插补、数据清洗；一键生成符合医学顶级期刊标准的 Table 1 基线特征表、Kaplan-Meier 生存分析曲线（附带 Log-rank p 值与 95% 置信区间）及 Cox 比例风险回归森林图。
- **零 PHI (Zero-PHI) 临床隐私架构**：全流程使用去标识研究代号；医生添加的备注名只保存在本机浏览器 localStorage；上传 DICOM 时清除常见身份标签。
- **多租户安全沙箱与 AES-256-GCM 隔离**：租户级独立密钥加密隔离；敏感操作（删除、高风险编辑）强制弹出红白确认卡拦截并审计留痕。

### v2.1.0 (2026年4月)
- **文档与学术汇报幻灯片双模态无损写作**：原生支持 Word (DOCX)、PPTX、Markdown 双向高保真导入导出，告别格式排版错乱。
- **伴随式 AI 协作与红绿 Diff 修订机制**：AI 输出以高亮修订形式呈现，支持临床医生逐条采纳、修改或驳回，真正落实 Human-in-the-Loop 医疗责任闭环。
- **PubMed 全球医学文献检索与自动引用溯源**：智能匹配并检索 PubMed 权威医学文献，一键生成规范格式参考文献，并在正文中插入关联溯源标记。
- **Python + Resvg 矢量科研图表生成**：工作区内安全执行高精度统计作图脚本，生成 Publication-Ready 矢量级配图。

### v2.0.0 (2026年2月)
- **Heurion 平台 2.0 全新架构里程碑发布**：全新三栏墨绿极客工作台；知家 (PHR) 个人专属家庭健康空间；科室多级诊疗组 (Care Team) 与受控安全分享。
`
}

const HELP_GROUPS = [
  { title: '入门与通识', ids: ['overview', 'concepts'] },
  { title: '安全与协同', ids: ['privacy', 'collaboration'] },
  { title: '临床影像中心', ids: ['imaging', 'registration', 'diagnostics', 'casestudy'] },
  { title: '临床科研与出版', ids: ['research'] },
  { title: '学术写作与文献', ids: ['writing', 'citations', 'faq', 'releasenotes'] },
]

/** 打开交互式产品使用指南弹窗 */
export function openHelpGuide(initialSectionId = 'overview'): void {
  const dlg = document.getElementById('dialog')!
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

  dlg.innerHTML = `
    <div class="dialog-card wide help-dialog" role="dialog" aria-modal="true" aria-label="Heurion 产品使用手册与操作指南">
      <div class="dialog-head help-head">
        <div class="help-head-title">
          <h2>${icon('file', { size: 18 })} Heurion 临床智能工作站 · 全流程使用手册</h2>
          <span class="help-version-pill">v2.7 Pro</span>
        </div>
        <div class="help-head-actions">
          <div class="help-search-wrap">
            <input type="search" id="helpFilterInput" placeholder="搜索手册章节或关键词..." autocomplete="off">
          </div>
          <button id="helpImportDocBtn" class="primary small-btn" title="在您的工作区新建一份完整手册文档，方便随时查阅与边写边看">${icon('download')} 导入为参考文档</button>
          <button class="quiet" data-close aria-label="关闭">✕</button>
        </div>
      </div>
      <div class="help-split-layout">
        <aside class="help-sidebar" id="helpSidebar">
          <div class="help-sidebar-title">手册目录导航</div>
          <nav class="help-nav" id="helpNav">
            ${HELP_GROUPS.map(group => `
              <div class="help-nav-group">
                <div class="help-nav-group-title">${esc(group.title)}</div>
                ${group.ids.map(id => {
                  const sec = HELP_SECTIONS.find(s => s.id === id)
                  if (!sec) return ''
                  const idx = HELP_SECTIONS.indexOf(sec)
                  return `
                    <button class="help-nav-item${sec.id === initialSectionId ? ' active' : ''}" data-target="${esc(sec.id)}">
                      <span class="hni-icon">${sec.icon}</span>
                      <span class="hni-text">${idx + 1}. ${esc(sec.title)}</span>
                      <span class="hni-badge">${esc(sec.badge)}</span>
                    </button>
                  `
                }).join('')}
              </div>
            `).join('')}
          </nav>
          <div class="help-sidebar-footer">
            <div class="hsf-tip">${icon('info', { size: 13 })} 提示：按 <code>Esc</code> 键可快速关闭手册。</div>
            <div class="hsf-contact" style="margin-top: 8px; font-size: 12px; color: var(--muted);"><a href="mailto:support@heurion.org" style="color: var(--mint); text-decoration: underline; text-underline-offset: 3px;">联系我们 support@heurion.org</a></div>
          </div>
        </aside>
        <main class="help-content-area" id="helpContentArea">
          ${HELP_SECTIONS.map(sec => `
            <section class="help-section" id="help-sec-${esc(sec.id)}" data-sec-id="${esc(sec.id)}">
              ${sec.contentHtml}
            </section>
          `).join('')}
        </main>
      </div>
    </div>
  `
  dlg.hidden = false

  const close = () => {
    dlg.hidden = true
    dlg.innerHTML = ''
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  dlg.onclick = e => {
    if (e.target === dlg || (e.target as HTMLElement).closest('[data-close]')) close()
  }

  // 导航点击跳转
  const navContainer = dlg.querySelector('#helpNav')!
  const contentArea = dlg.querySelector('#helpContentArea') as HTMLElement
  navContainer.addEventListener('click', e => {
    const item = (e.target as HTMLElement).closest('.help-nav-item') as HTMLElement | null
    if (!item || !item.dataset.target) return
    const targetId = item.dataset.target
    const secEl = dlg.querySelector(`#help-sec-${targetId}`) as HTMLElement | null
    if (secEl && contentArea) {
      navContainer.querySelectorAll('.help-nav-item').forEach(b => b.classList.remove('active'))
      item.classList.add('active')
      contentArea.scrollTo({
        top: secEl.offsetTop - contentArea.offsetTop,
        behavior: 'smooth'
      })
    }
  })

  // 滚动时自动高亮左侧当前章节
  let scrollTimer: any = null
  contentArea.addEventListener('scroll', () => {
    if (scrollTimer) return
    scrollTimer = setTimeout(() => {
      scrollTimer = null
      const sections = Array.from(dlg.querySelectorAll<HTMLElement>('.help-section'))
      const currentScroll = contentArea.scrollTop + 60
      for (let i = sections.length - 1; i >= 0; i--) {
        const s = sections[i]
        if (!s) continue
        if (s.offsetTop - contentArea.offsetTop <= currentScroll) {
          const id = s.dataset.secId
          if (id) {
            navContainer.querySelectorAll<HTMLElement>('.help-nav-item').forEach(b => {
              b.classList.toggle('active', b.dataset.target === id)
            })
          }
          break
        }
      }
    }, 80)
  }, { passive: true })

  // 搜索过滤
  const filterInput = dlg.querySelector<HTMLInputElement>('#helpFilterInput')
  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const q = filterInput.value.trim().toLowerCase()
      const sections = dlg.querySelectorAll<HTMLElement>('.help-section')
      const navItems = dlg.querySelectorAll<HTMLElement>('.help-nav-item')
      const navGroups = dlg.querySelectorAll<HTMLElement>('.help-nav-group')
      if (!q) {
        sections.forEach(s => s.hidden = false)
        navItems.forEach(n => n.hidden = false)
        navGroups.forEach(g => g.hidden = false)
        return
      }
      sections.forEach(s => {
        const text = s.textContent?.toLowerCase() ?? ''
        const match = text.includes(q)
        s.hidden = !match
      })
      navItems.forEach(n => {
        const target = n.dataset.target
        const sec = dlg.querySelector<HTMLElement>(`#help-sec-${target}`)
        n.hidden = !sec || sec.hidden
      })
      navGroups.forEach(g => {
        const hasVisible = Array.from(g.querySelectorAll<HTMLElement>('.help-nav-item')).some(item => !item.hidden)
        g.hidden = !hasVisible
      })
    })
  }

  // 导入为参考文档
  const importBtn = dlg.querySelector<HTMLButtonElement>('#helpImportDocBtn')
  if (importBtn) {
    importBtn.onclick = () => {
      close()
      document.dispatchEvent(new CustomEvent('heurion:import-help-doc'))
    }
  }

  // 初始定位到目标章节
  if (initialSectionId) {
    setTimeout(() => {
      const secEl = dlg.querySelector(`#help-sec-${initialSectionId}`) as HTMLElement | null
      if (secEl && contentArea) {
        contentArea.scrollTop = secEl.offsetTop - contentArea.offsetTop
      }
    }, 60)
  }
}

/** 一键将手册导入为文档库中的正式参考指南 */
export async function importHelpAsDoc(
  api: ApiFn,
  loadDocs: () => Promise<void>,
  openDoc: (id: string) => Promise<void>,
  showNotice: (msg: string, isError?: boolean) => void
): Promise<void> {
  try {
    showNotice('正在将《产品使用手册》生成为工作区参考文档...')
    const markdown = buildHelpMarkdown()
    const title = 'Heurion 临床智能工作站全流程使用手册与操作指南'
    const res = await api<{ id: string }>('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, markdown })
    })
    await loadDocs()
    await openDoc(res.id)
    showNotice('《产品使用手册》已成功创建并打开！您可以随时在文档库中查阅或与 AI 对话。')
  } catch (err) {
    showNotice(`导入手册文档失败：${(err as Error).message}`, true)
  }
}
