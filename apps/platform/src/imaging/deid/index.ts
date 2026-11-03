/**
 * 浏览器端 DICOM 去标识化的共享模块（浏览器与服务端共用，纯 TS，不依赖 node 专有 API）。
 * 说明见 docs/design/IMAGING_STUDIES.md「去标识化」。web 端经相对路径引用（web/src/imaging-studies.ts）。
 */
export { DEID_SCHEME, DEID_METHOD, DEID_IMPLEMENTATION_CLASS_UID, PSEUDONYM, burnedInRisk, createDeidentifier, isClassUid, verifyDeidentified, vrOf, type DeidParams, type DeidResult, type Deidentifier } from './deidentify.ts'
export { DicomParseError, isDicomPart10, parseDicom, writeDicom, str as dicomString, find as findElement, type DicomElement, type DicomFile } from './dicom.ts'
export { WHITELIST, CLASS_UID_TAGS } from './whitelist.ts'
export { estimateSources, iterateSources, zipEstimate, type SourceEntry, type SourceFile } from './sources.ts'
