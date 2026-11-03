/**
 * 浏览器端 DICOM 去标识化的标签白名单（docs/design/IMAGING_STUDIES.md「去标识化」）。
 *
 * 原则：只保留阅片、AI 分析、随访对比与 DICOM SEG 需要的标签，其余一律删除——包括全部私有标签（奇数组）、
 * 60xx 叠加层、机构 / 医师 / 操作员 / 设备序列号 / StationName / AccessionNumber / 出生日期 / 地址 / OtherPatientIDs 等。
 * 语义对应 DICOM PS3.15 附录 E 的 Basic Application Level Confidentiality Profile，加两个选项：
 *   - Retain Longitudinal Temporal Information with Full Dates Option：检查 / 序列 / 采集的日期时间原样保留（随访对比要算间隔）；
 *   - Retain Patient Characteristics Option：保留性别、年龄、身高、体重（结节风险、剂量评估要用）。
 * 与 Basic Profile 的「黑名单 + 动作码」不同，这里是白名单：新出现的、不认识的标签默认删掉。
 *
 * 白名单是平铺的：同一张表用于顶层和所有序列的条目（Enhanced 多帧的功能组序列、SEG 的引用序列逐层按同一张表过滤）。
 * 每个标签都不含可识别信息，出现在哪一层都一样安全。
 *
 * vr：本表登记的 VR。隐式 VR 文件里没有 VR，靠它认出序列（SQ）与 UID（UI）；显式 VR 文件以文件里的 VR 为准。
 * kind：
 *   - keep：原值保留（UI 另按 UID 假名化规则映射）；
 *   - replace：原值丢弃，顶层写入服务端给的假名（PatientName / PatientID）；
 *   - generated：原值丢弃，顶层写入本方案的去标识标记。
 */

export type WhitelistKind = 'keep' | 'replace' | 'generated'
export interface WhitelistEntry { keyword: string; vr: string; kind: WhitelistKind }

/** [标签（8 位十六进制 GGGGEEEE）, 关键字, VR, 保留理由] */
const KEEP: Array<[string, string, string, string]> = [
  // —— 字符集与实例标识 ——
  ['00080005', 'SpecificCharacterSet', 'CS', '解码检查 / 序列描述等文字（中文常见 GB18030 / ISO_IR 192）'],
  ['00080008', 'ImageType', 'CS', '区分原始 / 重建 / 定位像，选序列与判断截屏（SCREEN SAVE）要用'],
  ['00080016', 'SOPClassUID', 'UI', '实例的类型（CT、Enhanced CT、SEG 等），阅片器按它选解析方式；类 UID 不假名化'],
  ['00080018', 'SOPInstanceUID', 'UI', '实例唯一标识；假名化后用于去重与 SEG 引用'],
  ['0020000D', 'StudyInstanceUID', 'UI', '检查唯一标识；假名化后用于索引、去重、冲突检测'],
  ['0020000E', 'SeriesInstanceUID', 'UI', '序列唯一标识；假名化后用于选序列、SEG 引用'],
  ['00200052', 'FrameOfReferenceUID', 'UI', '同一坐标系的序列共享；SEG 与多序列对齐要用（假名化后仍一致）'],
  ['00080060', 'Modality', 'CS', '模态（CT 等）：选序列、判断烧录风险'],
  ['00200011', 'SeriesNumber', 'IS', '序列号：阅片器排序显示'],
  ['00200012', 'AcquisitionNumber', 'IS', '采集号：区分同一序列内的多次采集'],
  ['00200013', 'InstanceNumber', 'IS', '实例号：层排序的后备依据'],

  // —— 日期与时间（Retain Longitudinal Temporal Information Full Dates）——
  ['00080020', 'StudyDate', 'DA', '检查日期：随访间隔、倍增时间计算'],
  ['00080021', 'SeriesDate', 'DA', '序列日期'],
  ['00080022', 'AcquisitionDate', 'DA', '采集日期'],
  ['00080023', 'ContentDate', 'DA', '图像生成日期（SEG 必需）'],
  ['0008002A', 'AcquisitionDateTime', 'DT', '采集日期时间（Enhanced 多帧）'],
  ['00080030', 'StudyTime', 'TM', '检查时间'],
  ['00080031', 'SeriesTime', 'TM', '序列时间'],
  ['00080032', 'AcquisitionTime', 'TM', '采集时间'],
  ['00080033', 'ContentTime', 'TM', '图像生成时间（SEG 必需）'],
  ['00189074', 'FrameAcquisitionDateTime', 'DT', 'Enhanced 多帧每帧的采集时间'],
  ['00189151', 'FrameReferenceDateTime', 'DT', 'Enhanced 多帧每帧的参考时间'],

  // —— 描述（自由文本，见文档「已知局限」：可能被录入人名）——
  ['00081030', 'StudyDescription', 'LO', '检查描述：检查列表显示、判断胸部 CT'],
  ['0008103E', 'SeriesDescription', 'LO', '序列描述：选序列（肺算法 / 纵隔窗）'],
  ['00181030', 'ProtocolName', 'LO', '扫描协议：选序列、质控'],
  ['00180015', 'BodyPartExamined', 'CS', '检查部位：判断胸部 CT'],

  // —— 患者特征（Retain Patient Characteristics）——
  ['00100040', 'PatientSex', 'CS', '性别：结节风险模型'],
  ['00101010', 'PatientAge', 'AS', '检查时年龄（不保留出生日期）：结节风险模型'],
  ['00101020', 'PatientSize', 'DS', '身高：剂量与体型校正'],
  ['00101030', 'PatientWeight', 'DS', '体重：剂量与体型校正'],
  ['00185100', 'PatientPosition', 'CS', '体位（HFS 等）：方向显示'],
  ['00102210', 'AnatomicalOrientationType', 'CS', '解剖方向类型：方向显示'],

  // —— 设备（不含序列号、StationName、机构）——
  ['00080070', 'Manufacturer', 'LO', '厂商：重建核解读、AI 质控分层'],
  ['00081090', 'ManufacturerModelName', 'LO', '设备型号：AI 质控分层'],

  // —— CT 采集与重建参数 ——
  ['00180022', 'ScanOptions', 'CS', '扫描方式（螺旋等）'],
  ['00180050', 'SliceThickness', 'DS', '层厚：选序列（≤ 2.5 mm）'],
  ['00180060', 'KVP', 'DS', '管电压：HU 解读、质控'],
  ['00180088', 'SpacingBetweenSlices', 'DS', '层间距：体积重建'],
  ['00180090', 'DataCollectionDiameter', 'DS', '采集视野'],
  ['00181100', 'ReconstructionDiameter', 'DS', '重建视野：像素间距校验'],
  ['00181120', 'GantryDetectorTilt', 'DS', '机架倾角：倾斜采集的几何校正'],
  ['00181130', 'TableHeight', 'DS', '床高：几何质控'],
  ['00181140', 'RotationDirection', 'CS', '旋转方向'],
  ['00181150', 'ExposureTime', 'IS', '曝光时间：剂量与噪声质控'],
  ['00181151', 'XRayTubeCurrent', 'IS', '管电流：剂量与噪声质控'],
  ['00181152', 'Exposure', 'IS', '曝光量：剂量与噪声质控'],
  ['00181160', 'FilterType', 'SH', '滤过类型'],
  ['00181210', 'ConvolutionKernel', 'SH', '重建核：选肺算法序列'],
  ['00189311', 'SpiralPitchFactor', 'FD', '螺距'],
  ['00189345', 'CTDIvol', 'FD', '剂量指数：质控'],
  ['00189314', 'CTReconstructionSequence', 'SQ', 'Enhanced CT 的重建参数（重建核、算法）'],
  ['00189315', 'ReconstructionAlgorithm', 'CS', '重建算法（迭代 / 滤波反投影）'],
  ['00189329', 'CTImageFrameTypeSequence', 'SQ', 'Enhanced CT 每帧的图像类型'],

  // —— 几何（阅片定位、测量、病人坐标）——
  ['00200032', 'ImagePositionPatient', 'DS', '层位置：体积重建、病人坐标'],
  ['00200037', 'ImageOrientationPatient', 'DS', '层方向：体积重建、病人坐标'],
  ['00201041', 'SliceLocation', 'DS', '层位置（后备排序依据）'],
  ['00200060', 'Laterality', 'CS', '左右侧'],
  ['00200062', 'ImageLaterality', 'CS', '图像左右侧'],
  ['00280030', 'PixelSpacing', 'DS', '像素间距：测量'],
  ['00181164', 'ImagerPixelSpacing', 'DS', '探测器像素间距（投影类影像测量）'],
  ['00280034', 'PixelAspectRatio', 'IS', '像素宽高比'],

  // —— 像素模块（像素字节原样拷贝）——
  ['00280002', 'SamplesPerPixel', 'US', '像素解码'],
  ['00280004', 'PhotometricInterpretation', 'CS', '像素解码（MONOCHROME2 等）'],
  ['00280006', 'PlanarConfiguration', 'US', '彩色像素排列'],
  ['00280008', 'NumberOfFrames', 'IS', '多帧帧数（Enhanced CT、SEG）'],
  ['00280009', 'FrameIncrementPointer', 'AT', '多帧帧序指针'],
  ['00280010', 'Rows', 'US', '像素解码'],
  ['00280011', 'Columns', 'US', '像素解码'],
  ['00280100', 'BitsAllocated', 'US', '像素解码'],
  ['00280101', 'BitsStored', 'US', '像素解码'],
  ['00280102', 'HighBit', 'US', '像素解码'],
  ['00280103', 'PixelRepresentation', 'US', '有无符号：HU 计算'],
  ['00280106', 'SmallestImagePixelValue', 'US', '像素值范围（US 或 SS）'],
  ['00280107', 'LargestImagePixelValue', 'US', '像素值范围（US 或 SS）'],
  ['00280120', 'PixelPaddingValue', 'US', '填充值：视野外像素不参与计算'],
  ['00280121', 'PixelPaddingRangeLimit', 'US', '填充值范围'],
  ['00281101', 'RedPaletteColorLookupTableDescriptor', 'US', '伪彩查找表（PALETTE COLOR 解码）'],
  ['00281102', 'GreenPaletteColorLookupTableDescriptor', 'US', '伪彩查找表'],
  ['00281103', 'BluePaletteColorLookupTableDescriptor', 'US', '伪彩查找表'],
  ['00281201', 'RedPaletteColorLookupTableData', 'OW', '伪彩查找表'],
  ['00281202', 'GreenPaletteColorLookupTableData', 'OW', '伪彩查找表'],
  ['00281203', 'BluePaletteColorLookupTableData', 'OW', '伪彩查找表'],
  ['00282110', 'LossyImageCompression', 'CS', '是否有损压缩过：AI 质控'],
  ['00282112', 'LossyImageCompressionRatio', 'DS', '有损压缩比'],
  ['00282114', 'LossyImageCompressionMethod', 'CS', '有损压缩方法'],
  ['00280301', 'BurnedInAnnotation', 'CS', '是否有烧录文字：保留以便服务端复核（YES 的文件不上传）'],
  ['00280302', 'RecognizableVisualFeatures', 'CS', '是否含可辨认的面部特征'],
  ['7FE00008', 'FloatPixelData', 'OF', '浮点像素数据'],
  ['7FE00009', 'DoubleFloatPixelData', 'OD', '双精度像素数据'],
  ['7FE00010', 'PixelData', 'OW', '像素数据（含封装压缩的片段，原样拷贝）'],

  // —— 灰度变换与窗宽窗位 ——
  ['00281050', 'WindowCenter', 'DS', '默认窗位'],
  ['00281051', 'WindowWidth', 'DS', '默认窗宽'],
  ['00281055', 'WindowCenterWidthExplanation', 'LO', '窗设置名称（肺窗 / 纵隔窗）'],
  ['00281056', 'VOILUTFunction', 'CS', 'VOI 函数（LINEAR / SIGMOID）'],
  ['00281052', 'RescaleIntercept', 'DS', 'HU 换算截距'],
  ['00281053', 'RescaleSlope', 'DS', 'HU 换算斜率'],
  ['00281054', 'RescaleType', 'LO', '换算后的单位（HU）'],
  ['20500020', 'PresentationLUTShape', 'CS', '显示查找表形状'],
  ['00283000', 'ModalityLUTSequence', 'SQ', '模态查找表（替代 Rescale 的写法）'],
  ['00283010', 'VOILUTSequence', 'SQ', 'VOI 查找表'],
  ['00283002', 'LUTDescriptor', 'US', '查找表描述'],
  ['00283003', 'LUTExplanation', 'LO', '查找表说明'],
  ['00283004', 'ModalityLUTType', 'LO', '模态查找表单位'],
  ['00283006', 'LUTData', 'US', '查找表数据（US 或 OW）'],

  // —— Enhanced 多帧功能组（按同一白名单逐层过滤，保留几何与像素相关的宏）——
  ['52009229', 'SharedFunctionalGroupsSequence', 'SQ', 'Enhanced 多帧所有帧共用的功能组'],
  ['52009230', 'PerFrameFunctionalGroupsSequence', 'SQ', 'Enhanced 多帧每帧的功能组（条目数须等于帧数，条目不删）'],
  ['00289110', 'PixelMeasuresSequence', 'SQ', '像素间距、层厚'],
  ['00209113', 'PlanePositionSequence', 'SQ', '每帧的层位置'],
  ['00209116', 'PlaneOrientationSequence', 'SQ', '每帧的层方向'],
  ['00289145', 'PixelValueTransformationSequence', 'SQ', '每帧的 HU 换算'],
  ['00289132', 'FrameVOILUTSequence', 'SQ', '每帧的窗宽窗位'],
  ['00209111', 'FrameContentSequence', 'SQ', '每帧的维度索引、堆栈位置'],
  ['00209056', 'StackID', 'SH', '堆栈编号'],
  ['00209057', 'InStackPositionNumber', 'UL', '堆栈内位置'],
  ['00209128', 'TemporalPositionIndex', 'UL', '时间位置索引'],
  ['00209156', 'FrameAcquisitionNumber', 'US', '帧采集号'],
  ['00209157', 'DimensionIndexValues', 'UL', '帧的维度索引值'],
  ['00209221', 'DimensionOrganizationSequence', 'SQ', '维度组织'],
  ['00209222', 'DimensionIndexSequence', 'SQ', '维度定义'],
  ['00209164', 'DimensionOrganizationUID', 'UI', '维度组织标识（假名化后仍一致）'],
  ['00209165', 'DimensionIndexPointer', 'AT', '维度指向的标签'],
  ['00209167', 'FunctionalGroupPointer', 'AT', '维度所在的功能组'],
  ['00209311', 'DimensionOrganizationType', 'CS', '维度组织类型（3D 等）'],
  ['00209421', 'DimensionDescriptionLabel', 'LO', '维度名称'],
  ['00089007', 'FrameType', 'CS', 'Enhanced 多帧每帧的图像类型'],
  ['00089205', 'PixelPresentation', 'CS', 'Enhanced CT 必需'],
  ['00089206', 'VolumetricProperties', 'CS', 'Enhanced CT 必需'],
  ['00089207', 'VolumeBasedCalculationTechnique', 'CS', 'Enhanced CT 必需'],

  // —— 引用（SEG 与派生影像指向原始影像；UID 同步假名化）——
  ['00081115', 'ReferencedSeriesSequence', 'SQ', 'SEG 引用的原始序列'],
  ['0008114A', 'ReferencedInstanceSequence', 'SQ', 'SEG 引用的原始实例'],
  ['00081140', 'ReferencedImageSequence', 'SQ', '定位像 / 参考图像引用'],
  ['00082112', 'SourceImageSequence', 'SQ', '派生帧的来源图像（SEG 每帧对应原始层）'],
  ['00089124', 'DerivationImageSequence', 'SQ', '派生图像（SEG 每帧的来源）'],
  ['00089215', 'DerivationCodeSequence', 'SQ', '派生方式（编码）'],
  ['00081150', 'ReferencedSOPClassUID', 'UI', '被引用实例的类型（类 UID 不假名化）'],
  ['00081155', 'ReferencedSOPInstanceUID', 'UI', '被引用实例（假名化，与被引用文件的 SOPInstanceUID 同步）'],
  ['00081160', 'ReferencedFrameNumber', 'IS', '被引用的帧'],

  // —— 编码条目（SEG 的分割属性、解剖部位、去标识方法码）——
  ['00080100', 'CodeValue', 'SH', '编码值（标准术语，不含个人信息）'],
  ['00080102', 'CodingSchemeDesignator', 'SH', '编码体系（DCM / SCT）'],
  ['00080103', 'CodingSchemeVersion', 'SH', '编码体系版本'],
  ['00080104', 'CodeMeaning', 'LO', '编码含义'],
  ['00082218', 'AnatomicRegionSequence', 'SQ', '解剖部位（编码）'],

  // —— DICOM SEG ——
  ['00620001', 'SegmentationType', 'CS', 'SEG：二值 / 分数'],
  ['00620002', 'SegmentSequence', 'SQ', 'SEG：分割段定义'],
  ['00620003', 'SegmentedPropertyCategoryCodeSequence', 'SQ', 'SEG：分割类别（编码）'],
  ['00620004', 'SegmentNumber', 'US', 'SEG：段号（病灶的分割引用）'],
  ['00620005', 'SegmentLabel', 'LO', 'SEG：段名称（显示）'],
  ['00620008', 'SegmentAlgorithmType', 'CS', 'SEG：自动 / 半自动 / 手工'],
  ['00620009', 'SegmentAlgorithmName', 'LO', 'SEG：算法名称'],
  ['0062000A', 'SegmentIdentificationSequence', 'SQ', 'SEG：每帧属于哪个段'],
  ['0062000B', 'ReferencedSegmentNumber', 'US', 'SEG：每帧的段号'],
  ['0062000D', 'RecommendedDisplayCIELabValue', 'US', 'SEG：显示颜色'],
  ['0062000E', 'MaximumFractionalValue', 'US', 'SEG：分数型最大值'],
  ['0062000F', 'SegmentedPropertyTypeCodeSequence', 'SQ', 'SEG：分割对象类型（编码）'],
  ['00620010', 'SegmentationFractionalType', 'CS', 'SEG：概率 / 占比'],
  ['00700080', 'ContentLabel', 'CS', 'SEG：内容标签（必需）'],
]

/** 原值丢弃、写入服务端给的假名 */
const REPLACE: Array<[string, string, string, string]> = [
  ['00100010', 'PatientName', 'PN', '写成患者假名：阅片器按它分组，不含真实姓名'],
  ['00100020', 'PatientID', 'LO', '写成患者假名：Orthanc 按它归档（患者 / 检查的内部 ID 由它派生）'],
]

/** 原值丢弃、写入本方案的标记 */
const GENERATED: Array<[string, string, string, string]> = [
  ['00120062', 'PatientIdentityRemoved', 'CS', '写 YES'],
  ['00120063', 'DeidentificationMethod', 'LO', '写本方案的名称与版本'],
  ['00120064', 'DeidentificationMethodCodeSequence', 'SQ', '写 PS3.15 的方法码（Basic Profile 与两个保留选项）'],
  ['00280303', 'LongitudinalTemporalInformationModified', 'CS', '写 UNMODIFIED（日期原样保留）'],
]

const parseTag = (hex: string) => parseInt(hex, 16) >>> 0

const entries = (rows: Array<[string, string, string, string]>, kind: WhitelistKind): Array<[number, WhitelistEntry]> =>
  rows.map(([t, keyword, vr]) => [parseTag(t), { keyword, vr, kind }])

export const WHITELIST: ReadonlyMap<number, WhitelistEntry> = new Map([...entries(KEEP, 'keep'), ...entries(REPLACE, 'replace'), ...entries(GENERATED, 'generated')])

/** 保存的是「类」UID 的标签：值是标准或厂商定义的类型标识，不指向具体患者 / 检查，不假名化 */
export const CLASS_UID_TAGS: ReadonlySet<number> = new Set([
  0x00020002, // MediaStorageSOPClassUID
  0x00020010, // TransferSyntaxUID
  0x00020012, // ImplementationClassUID
  0x00080016, // SOPClassUID
  0x0008001a, // RelatedGeneralSOPClassUID
  0x0008001b, // OriginalSpecializedSOPClassUID
  0x0008010c, // CodingSchemeUID
  0x00080117, // ContextUID
  0x00080118, // MappingResourceUID
  0x00081150, // ReferencedSOPClassUID
  0x00041510, // ReferencedSOPClassUIDInFile
  0x00041512, // ReferencedTransferSyntaxUIDInFile
  0x00080062, // SOPClassesInStudy
])
