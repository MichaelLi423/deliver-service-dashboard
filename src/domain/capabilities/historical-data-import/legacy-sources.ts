import { MAPPING_V1, SOURCE_TABLE_FILES, fileRouteByFileName, sheetRouteOf, type SheetRole } from './mapping';
import { findFieldByHeader, fieldCatalogFor } from './field-catalog';
import type { ImportCategory } from './workspace/workspace-model';

/**
 * 旧五份来源工作簿的冻结识别（design D21 / tasks 8.21）。
 *
 * - sheet 级：按冻结路由（文件 basename → sheet → 角色）精确匹配；
 *   未知 sheet 只进入「待人工映射或明确排除」，不做相似名称模糊猜测；
 * - 列级：源列名按目标字段目录的稳定别名精确匹配（exact=表头/字段名，
 *   alias=冻结别名），未知列进入 pending（待人工映射）或由用户明确排除；
 * - 来源优先级：合同字段以合同信息表为主要来源，执行字段以项目执行表
 *   为主要来源等（优先级数字越小越优先，来自冻结 mapping v1）。
 */

/** 未知 sheet/列的归类结果。 */
export type RecognitionState = 'exact' | 'unknown';
export type ColumnMappingState = 'exact' | 'alias' | 'pending' | 'ignored';

export interface SheetRecognition {
  sheet: string;
  /** 已知角色（project / service_order / ... / ignored / supplier / unmappable）。 */
  role: SheetRole | 'unknown';
  /** 解析出的目标类别（supplier/ignored/unmappable/unknown 为 null）。 */
  category: ImportCategory | null;
  state: RecognitionState;
  /** unknown 时给出原因（待人工映射或明确排除，不猜测）。 */
  reason?: string;
}

export interface ColumnRecognition {
  sourceColumn: string;
  targetField: string | null;
  state: ColumnMappingState;
}

/** 目标字段 → 类别角色映射（与 migration 引擎一致：sheet 角色与七类对应）。 */
const ROLE_TO_CATEGORY: Record<SheetRole, ImportCategory | null> = {
  project: 'project',
  service_order: 'service_order',
  invoice: 'invoice',
  logistics_fee: 'logistics_fee',
  serial_address_update: 'serial_address_update',
  qr_request: 'qr_request',
  ship_to_request: 'ship_to_request',
  supplier: null,
  ignored: null,
  unmappable: null,
};

export const LEGACY_SOURCE_FILES: readonly string[] = Object.values(SOURCE_TABLE_FILES);

/** 是否为旧五份来源工作簿文件（按冻结文件名 basename 匹配）。 */
export function isLegacySourceFile(fileName: string): boolean {
  return LEGACY_SOURCE_FILES.includes(fileName.trim());
}

/**
 * 冻结 sheet 识别：已知 sheet 返回角色与类别；未知 sheet 返回 state=unknown
 * （待人工映射或明确排除，不做模糊猜测）。
 */
export function recognizeLegacySheet(fileName: string, sheetName: string): SheetRecognition {
  const fileRoute = fileRouteByFileName(MAPPING_V1, fileName);
  if (!fileRoute) {
    return {
      sheet: sheetName,
      role: 'unknown',
      category: null,
      state: 'unknown',
      reason: `源文件「${fileName}」不在冻结映射中，sheet「${sheetName}」待人工映射或排除`,
    };
  }
  const route = sheetRouteOf(fileRoute, sheetName);
  if (!route) {
    return {
      sheet: sheetName,
      role: fileRoute.defaultRole === 'unmappable' ? 'unknown' : fileRoute.defaultRole,
      category: ROLE_TO_CATEGORY[fileRoute.defaultRole] ?? null,
      state: 'unknown',
      reason: `源文件「${fileName}」的 sheet「${sheetName}」未配置冻结映射，待人工映射或排除`,
    };
  }
  return {
    sheet: sheetName,
    role: route.role,
    category: ROLE_TO_CATEGORY[route.role],
    state: 'exact',
  };
}

/**
 * 冻结列识别：按目标字段目录稳定别名精确匹配。
 * 已知列 → exact/alias + 目标字段；未知列 → pending（待人工映射或排除）。
 */
export function recognizeLegacyColumns(
  category: ImportCategory,
  headerCells: readonly string[],
  options: { excluded?: readonly string[] } = {},
): ColumnRecognition[] {
  const excluded = new Set(options.excluded?.map((c) => c.trim()) ?? []);
  const results: ColumnRecognition[] = [];
  for (const raw of headerCells) {
    const sourceColumn = raw.trim();
    if (sourceColumn === '') continue;
    if (excluded.has(sourceColumn)) {
      results.push({ sourceColumn, targetField: null, state: 'ignored' });
      continue;
    }
    const field = findFieldByHeader(category, sourceColumn);
    if (field === undefined) {
      results.push({ sourceColumn, targetField: null, state: 'pending' });
      continue;
    }
    results.push({
      sourceColumn,
      targetField: field.field,
      state: field.label === sourceColumn || field.field === sourceColumn ? 'exact' : 'alias',
    });
  }
  return results;
}

/** 模板模式的列识别（表头即目标字段 label，不依赖旧五源别名猜测）。 */
export function recognizeTemplateColumns(category: ImportCategory, headerCells: readonly string[]): ColumnRecognition[] {
  return recognizeLegacyColumns(category, headerCells);
}

/**
 * 旧五源来源优先级：返回目标字段在给定源表中的优先级（数字越小越优先）。
 * 未配置该字段的来源返回 null。
 */
export function legacySourcePriority(sourceTable: string, targetField: string): number | null {
  const field = MAPPING_V1.fields.find((f) => f.target === targetField);
  if (!field) return null;
  const refs = field.sources.filter((s) => s.table === sourceTable);
  if (refs.length === 0) return null;
  return Math.min(...refs.map((r) => r.priority));
}

/** 七类目标字段目录（供列映射界面展示全部可用目标字段）。 */
export function targetFieldsFor(category: ImportCategory): readonly string[] {
  return fieldCatalogFor(category).map((f) => f.field);
}
