/**
 * 领域错误类型。
 * code 用于程序化判断，message 用于就地提示。
 */

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 金额字符串解析失败（非法格式、负数等）。 */
export class MoneyParseError extends DomainError {
  constructor(message: string) {
    super('MONEY_PARSE', message);
    this.name = 'MoneyParseError';
  }
}

/** 业务 ID / 唯一性校验失败（如客户名称 trim 后重复、ECC 重复、服务单号重复）。 */
export class UniquenessError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'UniquenessError';
  }
}

/** 通用业务校验失败（必填缺失、状态非法、取消约束等）。 */
export class ValidationError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ValidationError';
  }
}

/** 数据访问层错误（SQLite 约束冲突等），code 保留底层错误码便于判别。 */
export class PersistenceError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'PersistenceError';
  }
}
