import { UniquenessError, ValidationError } from '../../core/errors';
import { assertRequiredText, newInternalId } from '../../core/ids';
import type { ActorSnapshot } from '../../core/source';
import { assertValidIso, SystemClock, type Clock } from '../../core/time';
import type { Project, ProjectRepository } from '../relocation-project-lifecycle';
import { ORDER_TYPES, type OrderType, type ServiceOrder } from './service-order';
import type { ServiceOrderRepository, WizardSaveGateway } from './service-order-repositories';

/**
 * service-order-recording 领域服务（tasks 3.8~3.10）。
 *
 * - 3.8 四类开单：搬迁开单关联搬迁项目；认证/单寄备件/PM 开单独立保存、
 *   不进入搬迁项目生命周期；开单时间未填默认当前时间（TBD-22）。
 * - 3.9 非空服务单号全局唯一、四类共用唯一空间（TBD-21）；开单不改变项目
 *   进单状态与主状态；开单工作量按唯一服务单号计数并按四类业务分组。
 * - 3.10 项目向导选填单号自动创建搬迁开单记录：填写单号则参与工程师必填，
 *   未选定工程师拒绝保存整个向导；满足时项目与开单经 WizardSaveGateway
 *   原子保存（同一保存操作一并落库）；未填单号不创建任何开单记录。
 *
 * 所有手工事实（含向导自动创建的开单）绑定当前登录账号归属（design D12）。
 */

/** 手工登记开单输入（3.8/3.9）。 */
export interface ServiceOrderInput {
  orderType: OrderType;
  /** 非空服务单号全局唯一（四类共用唯一空间）。 */
  serviceOrderNo: string;
  /** 开单时间（未填默认当前时间，TBD-22）。 */
  orderedAt?: string;
  /** 参与工程师（必填）。 */
  engineer: string;
  /** 客户单位（必填）。 */
  customerName: string;
  /** 搬迁开单关联的搬迁项目（内部 ID）；其余三类不得提供。 */
  projectId?: string | null;
  /** 备注可选。 */
  note?: string | null;
}

/** 向导保存输入（3.10）。 */
export interface WizardSaveInput {
  /** 已按 relocation-project-lifecycle 规则构建的待保存项目（未持久化）。 */
  project: Project;
  /** 向导执行准备步骤的参与工程师（填写服务单号时必填）。 */
  engineers: string[];
  /** 选填服务单号；填写时参与工程师必填，未选定则拒绝保存整个向导。 */
  serviceOrderNo?: string | null;
  /** 客户单位（自动创建的搬迁开单必填字段）。 */
  customerName: string;
  /** 开单时间（缺省当前时间）。 */
  orderedAt?: string;
}

export interface WizardSaveResult {
  project: Project;
  /** 填写单号时自动创建的搬迁开单记录；未填单号时为 null。 */
  order: ServiceOrder | null;
}

/** 开单工作量：按唯一服务单号计数、按四类业务分组（3.9）。 */
export interface OrderWorkloadRow {
  orderType: OrderType;
  count: number;
}

export class ServiceOrderService {
  constructor(
    private readonly orders: ServiceOrderRepository,
    private readonly projects?: ProjectRepository,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  /**
   * 手工登记开单记录。
   * - 搬迁开单必须关联一个已存在的搬迁项目。
   * - 认证/单寄备件/PM 开单独立保存、不得关联搬迁项目生命周期。
   */
  recordOrder(input: ServiceOrderInput, actor: ActorSnapshot): ServiceOrder {
    if (!(ORDER_TYPES as readonly string[]).includes(input.orderType)) {
      throw new ValidationError(
        'ILLEGAL_ORDER_TYPE',
        `开单类型仅限 ${ORDER_TYPES.join('、')}`,
      );
    }
    const orderNo = assertRequiredText(input.serviceOrderNo, '服务单号');
    const engineer = assertRequiredText(input.engineer, '工程师');
    const customerName = assertRequiredText(input.customerName, '客户单位');
    this.assertOrderNoUnique(orderNo);

    let projectId: string | null = null;
    if (input.orderType === 'relocation') {
      projectId = assertRequiredText(input.projectId ?? null, '搬迁开单关联的搬迁项目');
      if (this.projects && !this.projects.findById(projectId)) {
        throw new ValidationError('PROJECT_NOT_FOUND', `搬迁项目不存在: ${projectId}`);
      }
    } else if (input.projectId !== undefined && input.projectId !== null) {
      throw new ValidationError(
        'NON_RELOCATION_ORDER_NO_PROJECT',
        '认证/单寄备件/PM 开单独立保存，不关联搬迁项目生命周期',
      );
    }

    const orderedAt = input.orderedAt ?? this.now();
    assertValidIso(orderedAt, '开单时间');
    const now = this.now();
    const order: ServiceOrder = {
      id: newInternalId(),
      orderType: input.orderType,
      serviceOrderNo: orderNo,
      orderedAt,
      engineer,
      customerName,
      projectId,
      note: input.note?.trim() === '' ? null : (input.note?.trim() ?? null),
      accountId: actor.accountId,
      usernameSnapshot: actor.username,
      createdAt: now,
      updatedAt: now,
    };
    this.orders.save(order);
    return order;
  }

  findByServiceOrderNo(serviceOrderNo: string): ServiceOrder | undefined {
    return this.orders.findByServiceOrderNo(serviceOrderNo);
  }

  /** 后补备注：备注缺失不影响记录保存，可随时补填。 */
  updateNote(orderId: string, note: string | null, actor: ActorSnapshot): ServiceOrder {
    const order = this.orders.findById(orderId);
    if (!order) {
      throw new ValidationError('ORDER_NOT_FOUND', `开单记录不存在: ${orderId}`);
    }
    order.note = note?.trim() === '' ? null : (note?.trim() ?? null);
    order.accountId = actor.accountId;
    order.usernameSnapshot = actor.username;
    order.updatedAt = this.now();
    this.orders.save(order);
    return order;
  }

  listOrders(): ServiceOrder[] {
    return this.orders.list();
  }

  listByProject(projectId: string): ServiceOrder[] {
    return this.orders.listByProject(projectId);
  }

  /**
   * 开单工作量：按唯一服务单号计数（同一服务单关联多名工程师或多次上门仍只计
   * 一次）、按搬迁/认证/单寄备件/PM 四类业务分组（3.9 / 7.4）。
   */
  countWorkload(): OrderWorkloadRow[] {
    const counts = new Map<OrderType, number>();
    for (const order of this.orders.list()) {
      if (order.serviceOrderNo === null) continue; // 无单号不计工作量
      counts.set(order.orderType, (counts.get(order.orderType) ?? 0) + 1);
    }
    return ORDER_TYPES.filter((t) => counts.has(t)).map((t) => ({
      orderType: t,
      count: counts.get(t)!,
    }));
  }

  private assertOrderNoUnique(orderNo: string): void {
    const existing = this.orders.findByServiceOrderNo(orderNo);
    if (existing) {
      throw new UniquenessError(
        'SERVICE_ORDER_NO_UNIQUE',
        `服务单号「${orderNo}」已存在，非空服务单号全局唯一（四类业务共用唯一空间）`,
      );
    }
  }

  private now(): string {
    return this.clock.nowIso();
  }
}

/**
 * 项目向导选填单号自动创建开单记录（3.10 / TBD-21/22）。
 * 领域服务只负责校验与组装，持久化经 WizardSaveGateway 原子完成：
 * - 填写单号但未选定参与工程师 → 拒绝保存整个向导（项目也不保存）。
 * - 填写且已选定参与工程师 → 项目与自动创建的搬迁开单记录同次保存，
 *   开单时间默认当前时间、备注可空允许后补。
 * - 未填写单号 → 不创建任何开单记录。
 */
export class ProjectWizardService {
  constructor(
    private readonly orders: ServiceOrderRepository,
    private readonly gateway: WizardSaveGateway,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  save(input: WizardSaveInput, actor: ActorSnapshot): WizardSaveResult {
    const orderNo = input.serviceOrderNo?.trim() ?? '';
    let order: ServiceOrder | null = null;

    if (orderNo !== '') {
      if (input.engineers.length === 0) {
        throw new ValidationError(
          'WIZARD_ENGINEERS_REQUIRED',
          '填写服务单号时参与工程师变为必填；未选定参与工程师拒绝保存整个向导，请先补齐参与工程师',
        );
      }
      const engineers = input.engineers.map((name) => assertRequiredText(name, '参与工程师'));
      const customerName = assertRequiredText(input.customerName, '客户单位');
      if (this.orders.findByServiceOrderNo(orderNo)) {
        throw new UniquenessError(
          'SERVICE_ORDER_NO_UNIQUE',
          `服务单号「${orderNo}」已存在，非空服务单号全局唯一`,
        );
      }
      const now = this.now();
      const orderedAt = input.orderedAt ?? now;
      assertValidIso(orderedAt, '开单时间');
      order = {
        id: newInternalId(),
        orderType: 'relocation',
        serviceOrderNo: orderNo,
        orderedAt,
        engineer: engineers.join('、'),
        customerName,
        projectId: input.project.id,
        note: null, // 备注可空并允许后补
        accountId: actor.accountId,
        usernameSnapshot: actor.username,
        createdAt: now,
        updatedAt: now,
      };
    }

    // 原子保存：项目与（可选的）自动创建开单记录同次落库；失败整体不写入。
    this.gateway.saveAtomically(input.project, order);
    return { project: input.project, order };
  }

  private now(): string {
    return this.clock.nowIso();
  }
}
