"""数据集导入（平台在用户的隔离环境里运行它：上传的文件不可信，解析不在平台进程里做）。

  python3 dataset_ingest.py <输入文件> <输出目录> [--sheet 工作表名] [--dict-sheet 字典工作表名] [--drop 列名 ...]

读 CSV / TSV / TXT（UTF-8 或 GBK）、Excel（自动识别多工作表中的「数据表」与「数据字典 / 变量编码表」，或按 --sheet / --dict-sheet 指定；支持双行表头剥离）、SAS（.xpt / .sas7bdat）、SPSS（.sav）、Stata（.dta），
输出：
  data.csv      UTF-8 的规范表（--drop 指定的列已删掉，双行表头中的说明行已剥离）
  profile.json  行数、每列的类型 / 缺失 / 唯一值 / 统计摘要、原文件或数据字典里的变量标签 / 单位 / 分类值编码（value_labels）、工作表清单，以及疑似身份信息的列
"""
import json
import math
import re
import sys
from pathlib import Path

import pandas as pd

MAX_ROWS = 2_000_000

# 疑似身份信息：列名，或取值的格式（身份证号、手机号、邮箱）
NAME_PATTERNS = [
    (re.compile(r'(姓名|名字|患者名|病人名|^name$|full_?name|patient_?name|first_?name|last_?name|surname)', re.I), '姓名'),
    (re.compile(r'(身份证|证件号|id_?card|national_?id|ssn|passport|护照)', re.I), '证件号'),
    (re.compile(r'(电话|手机|联系方式|phone|mobile|tel$|telephone)', re.I), '电话'),
    (re.compile(r'(病历号|住院号|门诊号|病案号|就诊号|登记号|医保号|mrn|medical_?record|admission_?no|hospital_?no)', re.I), '病历号 / 住院号'),
    (re.compile(r'(住址|地址|家庭住址|address|street|zip|邮编|postcode)', re.I), '地址'),
    (re.compile(r'(出生日期|生日|birth_?date|date_?of_?birth|^dob$|birthday)', re.I), '出生日期'),
    (re.compile(r'(邮箱|e-?mail)', re.I), '邮箱'),
]
VALUE_PATTERNS = [
    (re.compile(r'^\d{17}[\dXx]$'), '身份证号'),
    (re.compile(r'^(\+?86[- ]?)?1[3-9]\d{9}$'), '手机号'),
    (re.compile(r'^[\w.+-]+@[\w-]+\.[\w.-]+$'), '邮箱'),
]

# 工作表与数据字典识别正则
DICT_SHEET_RE = re.compile(
    r'字典|说明|编码|变量|注释|取值|指标说明|codebook|dict|dictionary|variable|variables|legend|meta|metadata|schema|notes',
    re.I,
)
DATA_SHEET_RE = re.compile(
    r'数据|患者|病例|队列|基线|主表|观察|受试者|data|dataset|cohort|patients|subjects|baseline|records|main',
    re.I,
)

DICT_VAR_COL_RE = re.compile(
    r'^(?:变量名|变量代码|变量名称|变量|字段名|字段代码|字段|列名|列代码|英文名|英文缩写|缩写|指标代码|编码名|variable|var_?name|var_?code|var|column|col_?name|field|field_?name|code|name|id)$',
    re.I,
)
DICT_LABEL_COL_RE = re.compile(
    r'^(?:中文名|中文名称|变量标签|标签|变量说明|字段说明|说明|含义|名称|描述|指标名称|临床含义|定义|label|var_?label|description|desc|meaning|title|display_?name|chinese_?name)$',
    re.I,
)
DICT_UNIT_COL_RE = re.compile(
    r'^(?:单位|量纲|计量单位|unit|units|measurement_?unit)$',
    re.I,
)
DICT_CODING_COL_RE = re.compile(
    r'^(?:赋值|赋值说明|编码|编码说明|取值|取值说明|取值范围|选项|分类|分类说明|值标签|值说明|备注|注释|coding|code_?desc|values|value_?labels|levels|categories|options|note|notes|remark|remarks)$',
    re.I,
)
DICT_CODE_KEY_COL_RE = re.compile(
    r'^(?:代码|编码值|数值|值|选项值|code_?val|value|level|key|option_?code)$',
    re.I,
)
DICT_CODE_VAL_COL_RE = re.compile(
    r'^(?:代码说明|编码含义|值含义|选项说明|类别名称|value_?label|level_?label|meaning|category)$',
    re.I,
)

# 匹配形如 "0=否, 1=是" / "1: 保守; 2: 手术" / "0-无 1-有" 的编码对
CODING_PAIR_RE = re.compile(
    r'(?:^|[,，;；/、|\n\r\t]+|\s{1,4})'
    r'([+-]?\d+(?:\.\d+)?|[A-Za-z0-9_]{1,12})'
    r'\s*(?:=|:|：|->|→|--|—|-)\s*'
    r'([^,，;；/、|\n\r=：:（）()]{1,40}?)'
    r'(?=$|[,，;；/、|\n\r\t]+|\s+[+-]?\d+\s*(?:=|:|：|-)|[）)])'
)

# 匹配自然语言赋值如 "1代表达格列净组，0代表常规对照组" / "0表示否，1表示是"
NL_CODE_FIRST_RE = re.compile(
    r'(?:^|[,，;；/、。\n\r\t]+|\s+)'
    r'([+-]?\d+|[A-Za-z]{1,6})'
    r'\s*(?:代表|表示|表示的是|指|对应|即为|记作|定义为|为)\s*'
    r'([^,，;；/、。\n\r=：:（）()]{1,36}?)'
    r'(?=$|[,，;；/、。\n\r\t]+|\s+[+-]?\d+\s*(?:代表|表示|指|对应|为)|[）)])'
)

# 匹配自然语言反向赋值如 "男记为1，女记为2" / "无赋值为0，有赋值为1"
NL_LABEL_FIRST_RE = re.compile(
    r'(?:^|[,，;；/、。\n\r\t]+|\s+)'
    r'([^,，;；/、。\n\r=：:（）()\d]{1,24}?)'
    r'\s*(?:记为|赋值为|编码为|代码为|记作|定义为)\s*'
    r'([+-]?\d+|[A-Za-z]{1,6})'
    r'(?=$|[,，;；/、。\n\r\t]+|[）)])'
)

PAREN_CONTENT_RE = re.compile(r'[（(]([^（）()]{1,120})[）)]')


def norm_col_key(val) -> str:
    if val is None:
        return ''
    s = str(val).strip()
    if not s or s.lower() in ('nan', 'none', 'null', '<na>'):
        return ''
    return re.sub(r'\s+', ' ', s).lower()


def norm_alnum_key(val) -> str:
    if val is None:
        return ''
    s = str(val).strip().lower()
    return re.sub(r'[^a-z0-9\u4e00-\u9fa5]', '', s)


def parse_value_labels(text) -> dict[str, str]:
    """从文本如 '0=否, 1=是'、'1:保守治疗; 2:手术治疗' 或 '1代表达格列净组，0代表对照组' 中解析分类值编码映射。"""
    if not text or not isinstance(text, str):
        return {}
    s = text.strip()
    if not s or s.lower() in ('nan', 'none', '-', '—', '/'):
        return {}
    out: dict[str, str] = {}
    for m in CODING_PAIR_RE.finditer(s):
        k = m.group(1).strip()
        v = m.group(2).strip()
        # 过滤像日期或纯数字区间 "2020-2025" / "10-20"
        if re.fullmatch(r'[+-]?\d+(?:\.\d+)?', k) and re.fullmatch(r'[+-]?\d+(?:\.\d+)?', v):
            continue
        if k and v and len(k) <= 16 and len(v) <= 40:
            out[k] = v
    if len(out) < 2:
        for m in NL_CODE_FIRST_RE.finditer(s):
            k = m.group(1).strip()
            v = m.group(2).strip()
            if re.fullmatch(r'[+-]?\d+(?:\.\d+)?', k) and re.fullmatch(r'[+-]?\d+(?:\.\d+)?', v):
                continue
            if k and v and len(k) <= 12 and len(v) <= 36:
                out[k] = v
    if len(out) < 2:
        for m in NL_LABEL_FIRST_RE.finditer(s):
            v = m.group(1).strip()
            k = m.group(2).strip()
            if k and v and len(k) <= 12 and len(v) <= 36:
                out[k] = v
    return out if len(out) >= 2 else {}


def extract_label_unit_and_codings(raw_label, raw_unit=None, raw_coding=None) -> dict:
    """
    综合原始标签列、单位列、赋值列，提取干净的 label、unit、value_labels 与 description。
    例如 raw_label="性别 (0=女, 1=男)" -> label="性别", value_labels={"0":"女","1":"男"}
    例如 raw_label="血肌酐 (μmol/L)" -> label="血肌酐 (μmol/L)", unit="μmol/L"
    """
    label = str(raw_label).strip() if raw_label is not None and pd.notna(raw_label) and str(raw_label).strip().lower() not in ('nan', 'none') else ''
    unit = str(raw_unit).strip() if raw_unit is not None and pd.notna(raw_unit) and str(raw_unit).strip().lower() not in ('nan', 'none', '-', '—') else ''
    coding_str = str(raw_coding).strip() if raw_coding is not None and pd.notna(raw_coding) and str(raw_coding).strip().lower() not in ('nan', 'none', '-', '—') else ''

    value_labels = parse_value_labels(coding_str)

    if label:
        for pm in PAREN_CONTENT_RE.finditer(label):
            inner = pm.group(1).strip()
            inner_codings = parse_value_labels(inner)
            if len(inner_codings) >= 2:
                if not value_labels:
                    value_labels = inner_codings
                label = label.replace(pm.group(0), '').strip()
            elif not unit and len(inner) <= 20 and not re.search(r'[=,，;；:：]', inner):
                if re.search(r'(?:岁|月|天|年|小时|mm|cm|kg|mg|ug|µg|ng|pg|mol|mmol|umol|µmol|L|dL|mL|g|IU|U/L|%|mmHg|kPa|Gy|HU|score|分|次)', inner, re.I):
                    unit = inner

    if unit and label and unit not in label:
        label = f'{label} ({unit})'
    elif unit and not label:
        label = f'({unit})'

    description = coding_str if coding_str and not value_labels else ''
    return {
        'label': label or None,
        'unit': unit or None,
        'value_labels': value_labels if value_labels else None,
        'description': description or None,
    }


def detect_two_row_header(df: pd.DataFrame) -> tuple[pd.DataFrame, dict, bool]:
    """
    检测第 0 行数据是否实际上是「第二行表头（中文标签 / 单位 / 编码说明）」。
    典型场景：
      Row 0 (columns): subject_id | age | sex | cr_umol
      Row 1 (df.iloc[0]): 患者编号 | 年龄(岁) | 性别(0=女,1=男) | 血肌酐(umol/L)
      Row 2+ (df.iloc[1:]): S001 | 65 | 1 | 98.4
    """
    if len(df) < 2 or len(df.columns) == 0:
        return df, {}, False

    first_row = df.iloc[0]
    rest_df = df.iloc[1:]
    if len(rest_df) == 0:
        return df, {}, False

    numeric_cols_in_rest = 0
    text_in_first_for_numeric = 0
    descriptive_hits = 0
    non_empty_first = 0

    for col in df.columns:
        v0 = first_row[col]
        if pd.isna(v0):
            continue
        s0 = str(v0).strip()
        if not s0:
            continue
        non_empty_first += 1

        is_s0_num = False
        try:
            float(s0.replace(',', ''))
            is_s0_num = True
        except Exception:
            is_s0_num = False

        s_rest = rest_df[col].dropna().astype(str).str.strip()
        s_rest = s_rest[~s_rest.map(lambda x: bool(MISSING_RE.match(x)))]
        if len(s_rest) > 0:
            num_rest = pd.to_numeric(s_rest, errors='coerce')
            if num_rest.notna().mean() >= 0.75:
                numeric_cols_in_rest += 1
                if not is_s0_num:
                    text_in_first_for_numeric += 1

        if not is_s0_num and (
            re.search(r'[\u4e00-\u9fa5]', s0)
            or PAREN_CONTENT_RE.search(s0)
            or len(parse_value_labels(s0)) >= 2
        ):
            descriptive_hits += 1

    if (
        numeric_cols_in_rest >= 1
        and text_in_first_for_numeric == numeric_cols_in_rest
        and non_empty_first > 0
        and descriptive_hits / non_empty_first >= 0.5
    ):
        meta = {}
        for col in df.columns:
            v0 = first_row[col]
            if pd.isna(v0):
                continue
            s0 = str(v0).strip()
            if not s0:
                continue
            info = extract_label_unit_and_codings(s0)
            if any(info.values()):
                meta[str(col).strip()] = info
        cleaned = rest_df.reset_index(drop=True)
        return cleaned, meta, True

    return df, {}, False


def normalize_dict_df(raw_df: pd.DataFrame) -> pd.DataFrame:
    """若字典表的第 1 行是合并标题行（Unnamed 列居多），自动下移到真正的字典表头行。"""
    if len(raw_df) == 0:
        return raw_df
    unnamed_cnt = sum(1 for c in raw_df.columns if str(c).lower().startswith('unnamed:'))
    if unnamed_cnt >= max(1, len(raw_df.columns) - 1) and len(raw_df) >= 2:
        for idx in range(min(3, len(raw_df))):
            row_vals = [str(v).strip() for v in raw_df.iloc[idx].tolist() if pd.notna(v) and str(v).strip()]
            if any(DICT_VAR_COL_RE.match(v) or DICT_LABEL_COL_RE.match(v) or DICT_CODING_COL_RE.match(v) for v in row_vals):
                new_cols = [
                    str(v).strip() if pd.notna(v) and str(v).strip() else f'col_{i}'
                    for i, v in enumerate(raw_df.iloc[idx].tolist())
                ]
                sub = raw_df.iloc[idx + 1:].copy()
                sub.columns = new_cols
                return sub.reset_index(drop=True)
    return raw_df


def measure_dict_overlap(dict_df: pd.DataFrame, data_cols) -> tuple[object | None, int, float]:
    """计算候选字典表 dict_df 中是否存在某列，其值与数据表列名集合 data_cols 重合。"""
    df = normalize_dict_df(dict_df)
    if len(df) == 0 or len(df.columns) == 0 or not list(data_cols):
        return None, 0, 0.0

    norm_data_cols = {
        norm_col_key(c): str(c)
        for c in data_cols
        if norm_col_key(c) and not norm_col_key(c).startswith('unnamed:')
    }
    if not norm_data_cols:
        return None, 0, 0.0

    best_col = None
    best_overlap = 0
    for col in df.columns:
        vals = {norm_col_key(v) for v in df[col].dropna().tolist()}
        vals.discard('')
        overlap = len(vals & set(norm_data_cols.keys()))
        if overlap > best_overlap:
            best_overlap = overlap
            best_col = col

    ratio = best_overlap / max(1, len(norm_data_cols))
    return best_col, best_overlap, ratio


def parse_dictionary_sheet(raw_dict_df: pd.DataFrame, data_cols) -> dict[str, dict]:
    """
    从数据字典工作表中解析每个变量的 label、unit、value_labels 与 description。
    支持单行每变量模式（0=否, 1=是）与多行每变量模式（代码列 + 含义列）。
    """
    df = normalize_dict_df(raw_dict_df)
    if len(df) == 0 or len(df.columns) == 0:
        return {}

    norm_to_actual = {norm_col_key(c): str(c).strip() for c in data_cols if norm_col_key(c)}
    cols = list(df.columns)

    var_col, overlap_cnt, _ = measure_dict_overlap(df, data_cols)
    if not var_col or overlap_cnt == 0:
        for c in cols:
            if DICT_VAR_COL_RE.match(str(c).strip()):
                var_col = c
                break
    if not var_col:
        var_col = cols[0]

    remaining_cols = [c for c in cols if c != var_col]

    label_col = None
    unit_col = None
    coding_col = None
    code_key_col = None
    code_val_col = None

    for c in remaining_cols:
        cs = str(c).strip()
        if not label_col and DICT_LABEL_COL_RE.match(cs):
            label_col = c
        elif not unit_col and DICT_UNIT_COL_RE.match(cs):
            unit_col = c
        elif not coding_col and DICT_CODING_COL_RE.match(cs):
            coding_col = c
        elif not code_key_col and DICT_CODE_KEY_COL_RE.match(cs):
            code_key_col = c
        elif not code_val_col and DICT_CODE_VAL_COL_RE.match(cs):
            code_val_col = c

    if not coding_col:
        best_coding_col = None
        best_coding_hits = 0
        for c in remaining_cols:
            if c in (label_col, unit_col):
                continue
            hits = sum(1 for v in df[c].dropna().astype(str) if len(parse_value_labels(v)) >= 2)
            if hits > best_coding_hits:
                best_coding_hits = hits
                best_coding_col = c
        if best_coding_hits >= 1:
            coding_col = best_coding_col

    if not label_col:
        for c in remaining_cols:
            if c not in (unit_col, coding_col, code_key_col, code_val_col):
                label_col = c
                break

    out: dict[str, dict] = {}
    current_var = None
    current_label = None

    for _, row in df.iterrows():
        raw_v = row.get(var_col)
        v_key = norm_col_key(raw_v) if pd.notna(raw_v) else ''
        if v_key:
            current_var = norm_to_actual.get(v_key, str(raw_v).strip())
            if label_col and pd.notna(row.get(label_col)):
                current_label = str(row.get(label_col)).strip()
            else:
                current_label = None
        elif not current_var:
            continue

        entry = out.setdefault(
            current_var,
            {'label': None, 'unit': None, 'value_labels': {}, 'description': None},
        )

        r_label = row.get(label_col) if label_col and pd.notna(row.get(label_col)) else current_label
        r_unit = row.get(unit_col) if unit_col and pd.notna(row.get(unit_col)) else None
        r_coding = row.get(coding_col) if coding_col and pd.notna(row.get(coding_col)) else None

        parsed = extract_label_unit_and_codings(r_label, r_unit, r_coding)
        if parsed['label'] and not entry['label']:
            entry['label'] = parsed['label']
        if parsed['unit'] and not entry['unit']:
            entry['unit'] = parsed['unit']
            if entry['label'] and parsed['unit'] not in entry['label']:
                entry['label'] = f"{entry['label']} ({parsed['unit']})"
        if parsed['value_labels']:
            entry['value_labels'].update(parsed['value_labels'])
        if parsed['description'] and not entry['description']:
            entry['description'] = parsed['description']

        if code_key_col and code_val_col:
            ck = row.get(code_key_col)
            cv = row.get(code_val_col)
            if pd.notna(ck) and pd.notna(cv):
                cks = str(ck).strip()
                if re.fullmatch(r'[+-]?\d+\.0', cks):
                    cks = cks[:-2]
                cvs = str(cv).strip()
                if cks and cvs and cks.lower() != 'nan' and cvs.lower() != 'nan':
                    entry['value_labels'][cks] = cvs

    cleaned_out: dict[str, dict] = {}
    for k, v in out.items():
        item = {}
        if v['label']:
            item['label'] = v['label']
        if v['unit']:
            item['unit'] = v['unit']
        if v['value_labels']:
            item['value_labels'] = v['value_labels']
        if v['description']:
            item['description'] = v['description']
        if item:
            cleaned_out[k] = item
    return cleaned_out


def select_excel_sheets(path: Path, requested_sheet: str | None = None, requested_dict_sheet: str | None = None):
    """
    分析 Excel 工作簿中的所有工作表：
    1. 自动判定每个工作表角色：'data'（数据表） vs 'dictionary'（数据字典/编码表）
    2. 返回 (df_data, dict_meta_by_col, sheets_summary, active_sheet_name, dict_sheet_name, is_two_row)
    """
    xl = pd.ExcelFile(path)
    sheet_names = [str(s) for s in xl.sheet_names]
    if not sheet_names:
        raise ValueError('Excel 文件中没有工作表')

    raw_dfs: dict[str, pd.DataFrame] = {}
    for name in sheet_names:
        try:
            raw_dfs[name] = xl.parse(sheet_name=name, nrows=MAX_ROWS)
        except Exception:
            raw_dfs[name] = pd.DataFrame()

    # 检查跨表列名重合关系：若工作表 B 的某列值高度覆盖工作表 A 的表头列名，则 B 是 A 的数据字典
    dict_pairs: dict[tuple[str, str], tuple[int, float]] = {}
    for b_name in sheet_names:
        for a_name in sheet_names:
            if a_name == b_name:
                continue
            df_a = raw_dfs[a_name]
            df_b = raw_dfs[b_name]
            if len(df_a.columns) < 2 or len(df_b) == 0:
                continue
            _, cnt, ratio = measure_dict_overlap(df_b, df_a.columns)
            if cnt >= 2 and (ratio >= 0.3 or cnt >= 3):
                dict_pairs[(b_name, a_name)] = (cnt, ratio)

    roles: dict[str, str] = {}
    for name in sheet_names:
        df = raw_dfs[name]
        if len(df) == 0 and len(df.columns) == 0:
            roles[name] = 'other'
            continue
        is_dict_by_pair = any(b == name for (b, _) in dict_pairs)
        is_data_by_pair = any(a == name for (_, a) in dict_pairs)
        if is_dict_by_pair and not is_data_by_pair:
            roles[name] = 'dictionary'
        elif is_data_by_pair and not is_dict_by_pair:
            roles[name] = 'data'
        elif DICT_SHEET_RE.search(name):
            roles[name] = 'dictionary'
        else:
            roles[name] = 'data'

    active_sheet = None
    if requested_sheet and requested_sheet in raw_dfs:
        active_sheet = requested_sheet
    else:
        data_candidates = [n for n in sheet_names if roles.get(n) == 'data' and len(raw_dfs[n].columns) > 0]
        if not data_candidates:
            data_candidates = [n for n in sheet_names if len(raw_dfs[n].columns) > 0]
        if data_candidates:
            def score_data_sheet(n: str):
                paired = max((cnt for (b, a), (cnt, _) in dict_pairs.items() if a == n), default=0)
                name_hit = 1 if DATA_SHEET_RE.search(n) and not DICT_SHEET_RE.search(n) else 0
                return (paired > 0, paired, name_hit, len(raw_dfs[n]))

            best_paired = max(data_candidates, key=score_data_sheet)
            if any(a == best_paired for (_, a) in dict_pairs) or roles.get(data_candidates[0]) == 'dictionary':
                active_sheet = best_paired
            else:
                active_sheet = data_candidates[0]
        else:
            active_sheet = sheet_names[0]

    dict_sheet = None
    if requested_dict_sheet is not None:
        if requested_dict_sheet and requested_dict_sheet.lower() not in ('none', 'null', 'false') and requested_dict_sheet in raw_dfs:
            dict_sheet = requested_dict_sheet
    else:
        best_cnt = 0
        for (b_name, a_name), (cnt, _) in dict_pairs.items():
            if a_name == active_sheet and b_name != active_sheet and cnt > best_cnt:
                best_cnt = cnt
                dict_sheet = b_name
        if not dict_sheet:
            for n in sheet_names:
                if n != active_sheet and roles.get(n) == 'dictionary':
                    dict_sheet = n
                    break

    df_data = raw_dfs[active_sheet]
    df_data, two_row_meta, is_two_row = detect_two_row_header(df_data)

    dict_meta: dict[str, dict] = {}
    if two_row_meta:
        dict_meta.update(two_row_meta)
    dict_preview_rows: list[list[str]] = []
    if dict_sheet and dict_sheet in raw_dfs:
        raw_dict = raw_dfs[dict_sheet]
        parsed_dict = parse_dictionary_sheet(raw_dict, df_data.columns)
        for col_name, info in parsed_dict.items():
            cur = dict_meta.setdefault(col_name, {})
            for k, v in info.items():
                if v:
                    cur[k] = v
        # 提取字典表纯文本预览（供 AI 核验器读取，过滤掉疑似敏感正则）
        norm_dict = normalize_dict_df(raw_dict)
        if len(norm_dict.columns) > 0:
            header_row = [str(c).strip()[:60] for c in norm_dict.columns[:10]]
            dict_preview_rows.append(header_row)
            for _, r in norm_dict.head(60).iterrows():
                cells = []
                for c in norm_dict.columns[:10]:
                    val = r.get(c)
                    if pd.isna(val):
                        cells.append('')
                    else:
                        sv = str(val).strip()[:120]
                        if any(pat.match(sv) for pat, _ in VALUE_PATTERNS):
                            sv = '[REDACTED]'
                        cells.append(sv)
                if any(cells):
                    dict_preview_rows.append(cells)

    sheets_summary = []
    for name in sheet_names:
        d = raw_dfs[name]
        r_cnt = int(len(df_data)) if name == active_sheet else int(len(d))
        role = 'dictionary' if name == dict_sheet else ('data' if name == active_sheet else roles.get(name, 'data'))
        cols_prev = [str(c).strip()[:40] for c in list(d.columns)[:25] if not any(pat.search(str(c)) for pat, _ in NAME_PATTERNS)]
        sheets_summary.append({
            'name': name,
            'rows': r_cnt,
            'cols': int(len(d.columns)),
            'role': role,
            'columns_preview': cols_prev,
        })

    return df_data, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows


def read(path: Path, requested_sheet: str | None = None, requested_dict_sheet: str | None = None):
    ext = path.suffix.lower()
    labels: dict = {}
    dict_meta: dict[str, dict] = {}
    sheets_summary = None
    active_sheet = None
    dict_sheet = None
    is_two_row = False
    dict_preview_rows: list[list[str]] = []

    if ext in ('.csv', '.tsv', '.txt'):
        sep = '\t' if ext == '.tsv' else None
        for enc in ('utf-8-sig', 'gb18030'):
            try:
                df = pd.read_csv(path, sep=sep, engine='python', encoding=enc, nrows=MAX_ROWS)
                df, dict_meta, is_two_row = detect_two_row_header(df)
                for col_name, info in dict_meta.items():
                    if info.get('label') and not labels.get(col_name):
                        labels[col_name] = info['label']
                return df, labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows
            except UnicodeDecodeError:
                continue
        raise ValueError('无法识别文件编码（试过 UTF-8 与 GBK）')
    if ext in ('.xlsx', '.xlsm', '.xls'):
        df, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows = select_excel_sheets(
            path,
            requested_sheet=requested_sheet,
            requested_dict_sheet=requested_dict_sheet,
        )
        for col_name, info in dict_meta.items():
            if info.get('label') and not labels.get(col_name):
                labels[col_name] = info['label']
        return df, labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows
    if ext in ('.xpt', '.sas7bdat'):
        df = pd.read_sas(path, format='xport' if ext == '.xpt' else 'sas7bdat', encoding='utf-8' if ext == '.sas7bdat' else None)
        return df, labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows
    if ext in ('.sav', '.zsav', '.dta'):
        try:
            import pyreadstat
            df, meta = (pyreadstat.read_sav if ext != '.dta' else pyreadstat.read_dta)(str(path), apply_value_formats=True)
            labels = {k: v for k, v in zip(meta.column_names, meta.column_labels or []) if v}
            if getattr(meta, 'variable_value_labels', None):
                for col_name, val_map in meta.variable_value_labels.items():
                    if val_map:
                        dict_meta.setdefault(col_name, {})['value_labels'] = {
                            (str(int(k)) if isinstance(k, float) and k.is_integer() else str(k)): str(v)
                            for k, v in val_map.items()
                        }
            return df, labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows
        except ImportError:
            if ext == '.dta':
                return pd.read_stata(path), labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows
            raise ValueError('读取 SPSS 文件需要 pyreadstat')
    raise ValueError(f'不支持的格式：{ext}')


# 临床数据表常见缺失值占位符（中文「缺失 / 未知 / 不详」及常见英文 NA 标记）
MISSING_RE = re.compile(r'^(缺失|缺失值|未知|不详|未记录|未查|无数据|na|n/a|null|none|nan|-|—|--|\.|/)$', re.I)


def clean_missing_and_types(df: pd.DataFrame) -> pd.DataFrame:
    """将临床表格中的文本型缺失占位符（如「缺失」、纯数值/日期列里的 'N'）转为缺失值，并恢复被污染的数值列类型。"""
    for c in df.columns:
        s = df[c]
        if s.dtype != object and not pd.api.types.is_string_dtype(s):
            continue
        stripped = s.map(lambda v: v.strip() if isinstance(v, str) else v)
        mask = stripped.map(lambda v: bool(MISSING_RE.match(v)) if isinstance(v, str) else False)
        # 若列中没有 'Y'/'Yes'，而有单独的 'N'，且其余非空值 >=80% 是数值或日期，则 'N' 也是缺失/未做占位符
        non_empty = stripped[~mask].dropna()
        if len(non_empty):
            upper_vals = non_empty.map(lambda v: v.upper() if isinstance(v, str) else '')
            has_n = (upper_vals == 'N').any()
            has_y = upper_vals.isin(('Y', 'YES')).any()
            rest = non_empty[upper_vals != 'N']
            if has_n and not has_y and len(rest) > 0:
                num_ratio = pd.to_numeric(rest, errors='coerce').notna().mean()
                date_ratio = rest.astype(str).str.contains(r'\d{4}').mean()
                if num_ratio >= 0.8 or date_ratio >= 0.8:
                    mask = mask | (stripped.map(lambda v: isinstance(v, str) and v.strip().upper() == 'N'))
        if mask.any():
            s = s.astype(object).mask(mask, pd.NA)
            df[c] = s
        # 去掉缺失占位符后，若剩余非空值全部可转为数值，则还原为数值列（例如含「缺失」的供血动脉数量、含 'N' 的中心剂量）
        nonnull = df[c].dropna()
        if len(nonnull) > 0:
            coerced = pd.to_numeric(nonnull, errors='coerce')
            if coerced.notna().all():
                df[c] = pd.to_numeric(df[c], errors='coerce')
    return df


def _is_date_series(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    nonnull = s.dropna().astype(str).str.strip()
    # 临床事件时间列常以 '0' 表示未发生事件（如未治疗、未出血），判断是否为日期列时排除 '0'
    non_zero = nonnull[~nonnull.isin(('0', '0.0', ''))]
    if len(non_zero) == 0:
        return False
    sample = non_zero.head(200)
    has_year = sample.str.contains(r'\d{4}').mean() >= 0.85
    if not has_year:
        return False
    cleaned = sample.str.replace(r'[术后前约左右]+$', '', regex=True)
    parsed = pd.to_datetime(cleaned, errors='coerce', format='mixed')
    return bool(parsed.notna().mean() >= 0.85)


def col_type(s: pd.Series, col_meta: dict | None = None) -> str:
    value_labels = (col_meta or {}).get('value_labels') or {}
    unit = (col_meta or {}).get('unit')
    if pd.api.types.is_bool_dtype(s):
        return 'categorical'
    if pd.api.types.is_numeric_dtype(s):
        if value_labels and s.dropna().nunique() <= max(12, len(value_labels) + 2):
            return 'categorical'
        if unit and not value_labels:
            return 'numeric'
        # 取值很少的整数（如 0/1、1–4 分期）也当分类
        return 'categorical' if s.dropna().nunique() <= 5 and (s.dropna() % 1 == 0).all() else 'numeric'
    if _is_date_series(s):
        return 'date'
    nonnull = s.dropna().astype(str)
    if value_labels:
        return 'categorical'
    if unit and not value_labels and len(nonnull) > 0:
        if pd.to_numeric(nonnull, errors='coerce').notna().mean() >= 0.8:
            return 'numeric'
    return 'categorical' if nonnull.nunique() <= max(20, len(nonnull) * 0.05) else 'text'


def num(x):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), 4)


def phi(name: str, s: pd.Series, label: str | None = None) -> dict | None:
    for pat, why in NAME_PATTERNS:
        if pat.search(str(name)) or (label and pat.search(str(label))):
            return {'reason': f'列名像{why}'}
    vals = s.dropna().astype(str).str.strip()
    if len(vals) == 0:
        return None
    sample = vals.head(2000)
    for pat, why in VALUE_PATTERNS:
        hits = int(sample.map(lambda v: bool(pat.match(v))).sum())
        if hits >= max(1, len(sample) * 0.02):
            return {'reason': f'取值像{why}（抽查 {len(sample)} 个，{hits} 个匹配）'}
    return None


def profile(df: pd.DataFrame, labels: dict, dict_meta: dict[str, dict] | None = None) -> dict:
    dict_meta = dict_meta or {}
    norm_dict_meta = {norm_col_key(k): v for k, v in dict_meta.items()}
    norm_labels = {norm_col_key(k): v for k, v in labels.items()}

    cols = []
    for name in df.columns:
        col_str = str(name)
        s = df[name]
        c_meta = dict_meta.get(col_str) or norm_dict_meta.get(norm_col_key(col_str)) or {}
        lbl = labels.get(col_str) or norm_labels.get(norm_col_key(col_str)) or c_meta.get('label')
        t = col_type(s, c_meta)
        c: dict = {'name': col_str, 'type': t, 'missing': int(s.isna().sum()), 'unique': int(s.nunique(dropna=True))}
        if lbl:
            c['label'] = str(lbl)
        if c_meta.get('unit'):
            c['unit'] = str(c_meta['unit'])
        if c_meta.get('description'):
            c['description'] = str(c_meta['description'])
        value_labels = c_meta.get('value_labels') or {}
        if value_labels:
            c['value_labels'] = dict(value_labels)

        if t == 'numeric':
            d = s.dropna().astype(float)
            if len(d):
                c['stats'] = {'mean': num(d.mean()), 'sd': num(d.std()), 'median': num(d.median()), 'q1': num(d.quantile(.25)), 'q3': num(d.quantile(.75)), 'min': num(d.min()), 'max': num(d.max())}
        elif t in ('categorical', 'text'):
            top = s.dropna().astype(str).value_counts().head(8)
            c['top'] = [
                {
                    'value': str(k)[:60],
                    'count': int(v),
                    **({'label': str(value_labels[str(k)])} if str(k) in value_labels else {}),
                }
                for k, v in top.items()
            ]
        elif t == 'date':
            non_zero = s.dropna().astype(str).str.strip()
            non_zero = non_zero[~non_zero.isin(('0', '0.0', ''))].str.replace(r'[术后前约左右]+$', '', regex=True)
            d = pd.to_datetime(non_zero, errors='coerce', format='mixed').dropna()
            if len(d):
                c['range'] = [d.min().date().isoformat(), d.max().date().isoformat()]
        flag = phi(col_str, s, lbl)
        if flag:
            c['phi'] = flag
        elif c['unique'] <= 10 and t in ('numeric', 'categorical'):
            uniq_vals = [str(v).strip() for v in s.dropna().unique()[:10] if len(str(v).strip()) <= 24]
            if uniq_vals:
                c['distinct_codes'] = uniq_vals
        cols.append(c)
    return {'rows': int(len(df)), 'columns': cols}


def parse_args(argv: list[str]) -> tuple[Path, Path, str | None, str | None, list[str]]:
    src = Path(argv[1])
    out = Path(argv[2])
    sheet: str | None = None
    dict_sheet: str | None = None
    drop: list[str] = []
    i = 3
    while i < len(argv):
        arg = argv[i]
        if arg == '--sheet' and i + 1 < len(argv):
            sheet = argv[i + 1]
            i += 2
        elif arg.startswith('--sheet='):
            sheet = arg.split('=', 1)[1]
            i += 1
        elif arg == '--dict-sheet' and i + 1 < len(argv):
            dict_sheet = argv[i + 1]
            i += 2
        elif arg.startswith('--dict-sheet='):
            dict_sheet = arg.split('=', 1)[1]
            i += 1
        elif arg == '--drop':
            i += 1
            while i < len(argv) and not argv[i].startswith('--'):
                drop.append(argv[i])
                i += 1
        else:
            i += 1
    return src, out, sheet, dict_sheet, drop


def main() -> None:
    src, out, req_sheet, req_dict_sheet, drop = parse_args(sys.argv)
    out.mkdir(parents=True, exist_ok=True)
    try:
        df, labels, dict_meta, sheets_summary, active_sheet, dict_sheet, is_two_row, dict_preview_rows = read(
            src,
            requested_sheet=req_sheet,
            requested_dict_sheet=req_dict_sheet,
        )
        df.columns = [str(c).strip() or f'col{i + 1}' for i, c in enumerate(df.columns)]
        if df.columns.duplicated().any():
            raise ValueError('有重名的列：' + '、'.join(sorted(set(df.columns[df.columns.duplicated()]))))
        df = df.drop(columns=[c for c in drop if c in df.columns])
        df = clean_missing_and_types(df)
        # 有缺失的整数列被 pandas 读成小数（1.0、2.0）：取值全是整数的改回整数，CSV 与概况里都写成 1、2
        for c in df.columns:
            if pd.api.types.is_float_dtype(df[c]):
                vals = df[c].dropna()
                if len(vals) and (vals % 1 == 0).all() and vals.abs().max() < 2**53:
                    df[c] = df[c].astype('Int64')
        # SAS 的字节串列转成文字
        for c in df.columns:
            if df[c].dtype == object and df[c].map(lambda v: isinstance(v, bytes)).any():
                df[c] = df[c].map(lambda v: v.decode('utf-8', 'replace') if isinstance(v, bytes) else v)
        df.to_csv(out / 'data.csv', index=False)
        result: dict = {'ok': True, **profile(df, labels, dict_meta), 'truncated': len(df) >= MAX_ROWS}
        if sheets_summary is not None:
            result['sheets'] = sheets_summary
            result['active_sheet'] = active_sheet
            result['dictionary_sheet'] = dict_sheet
        if dict_preview_rows:
            result['dict_preview_rows'] = dict_preview_rows
        if is_two_row:
            result['two_row_header'] = True
    except Exception as err:  # noqa: BLE001 — 失败原因原样给用户
        result = {'ok': False, 'error': str(err)[:500]}
    (out / 'profile.json').write_text(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
