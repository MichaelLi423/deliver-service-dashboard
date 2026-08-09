import { describe, expect, it } from 'vitest';
import {
  ProjectWizardService,
  ServiceOrderService,
} from '../../src/domain/capabilities/service-order-recording/service-order-service';
import { UniquenessError } from '../../src/domain/core/errors';
import { createPendingProject } from '../../src/domain/capabilities/relocation-project-lifecycle/project';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryProjectRepository } from '../helpers/in-memory-repos';
import {
  InMemoryServiceOrderRepository,
  InMemoryWizardSaveGateway,
} from '../helpers/service-order-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * service-order-recording 领域场景测试（tasks 3.8~3.10 实现，3.12 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const projects = new InMemoryProjectRepository();
  const orders = new InMemoryServiceOrderRepository();
  const orderService = new ServiceOrderService(orders, projects, CLOCK);
  const gateway = new InMemoryWizardSaveGateway(
    (p) => projects.save(p),
    (o) => orders.save(o),
  );
  const wizard = new ProjectWizardService(orders, gateway, CLOCK);
  return { projects, orders, orderService, gateway, wizard };
}

describe('四类开单与项目关联（3.8）', () => {
  it('搬迁开单关联对应搬迁项目', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);

    const order = orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-001',
        engineer: '工程师甲',
        customerName: '华东医药',
        projectId: project.id,
      },
      ACTOR,
    );
    expect(order.projectId).toBe(project.id);
    expect(order.orderType).toBe('relocation');
  });

  it('认证开单独立保存、不进入搬迁项目生命周期', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'certification',
        serviceOrderNo: 'ORD-002',
        engineer: '工程师乙',
        customerName: '华北医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
    expect(order.orderType).toBe('certification');
  });

  it('单寄备件开单独立保存', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'parts_by_mail',
        serviceOrderNo: 'ORD-003',
        engineer: '工程师丙',
        customerName: '华南医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
  });

  it('PM 开单独立保存', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'pm',
        serviceOrderNo: 'ORD-004',
        engineer: '工程师丁',
        customerName: '西部医药',
      },
      ACTOR,
    );
    expect(order.projectId).toBeNull();
    expect(order.orderType).toBe('pm');
  });

  it('非搬迁开单提供 projectId 时拒绝', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        {
          orderType: 'pm',
          serviceOrderNo: 'ORD-005',
          engineer: '工程师',
          customerName: '客户',
          projectId: 'p-1',
        },
        ACTOR,
      ),
    ).toThrow(/不关联搬迁项目生命周期/);
  });

  it('搬迁开单引用不存在的项目时拒绝', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        {
          orderType: 'relocation',
          serviceOrderNo: 'ORD-006',
          engineer: '工程师',
          customerName: '客户',
          projectId: 'not-exist',
        },
        ACTOR,
      ),
    ).toThrow(/搬迁项目不存在/);
  });
});

describe('服务单号全局唯一（3.9 / TBD-21）', () => {
  it('重复服务单号被拒', () => {
    const { orderService } = setup();
    orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-100', engineer: '工程师甲', customerName: '客户A' },
      ACTOR,
    );
    expect(() =>
      orderService.recordOrder(
        { orderType: 'pm', serviceOrderNo: 'ORD-100', engineer: '工程师乙', customerName: '客户B' },
        ACTOR,
      ),
    ).toThrow(UniquenessError);
  });

  it('不同业务类型共用唯一空间：搬迁单号被认证开单占用拒绝', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-200',
        engineer: '工程师甲',
        customerName: '客户A',
        projectId: project.id,
      },
      ACTOR,
    );
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-200', engineer: '工程师乙', customerName: '客户B' },
        ACTOR,
      ),
    ).toThrow(/全局唯一/);
  });
});

describe('认证、单寄备件与 PM 开单最小字段（3.8 / TBD-22）', () => {
  it('缺少服务单号、工程师或客户单位之一拒绝保存', () => {
    const { orderService } = setup();
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: '  ', engineer: '工程师', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(/服务单号/);
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-300', engineer: '  ', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(/工程师/);
    expect(() =>
      orderService.recordOrder(
        { orderType: 'certification', serviceOrderNo: 'ORD-300', engineer: '工程师', customerName: '  ' },
        ACTOR,
      ),
    ).toThrow(/客户单位/);
    expect(() =>
      orderService.recordOrder(
        { orderType: 'illegal-type' as never, serviceOrderNo: 'ORD-300', engineer: '工程师', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(/开单类型/);
  });

  it('记录全部最小字段后保存，且不关联搬迁项目生命周期', () => {
    const { orderService, orders } = setup();
    const order = orderService.recordOrder(
      {
        orderType: 'parts_by_mail',
        serviceOrderNo: 'ORD-301',
        orderedAt: '2026-07-01',
        engineer: '工程师甲',
        customerName: '华东医药',
      },
      ACTOR,
    );
    expect(orders.findById(order.id)?.id).toBe(order.id);
    expect(order.orderedAt).toBe('2026-07-01');
    expect(order.projectId).toBeNull();
  });

  it('开单时间未填默认当前时间', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-302', engineer: '工程师', customerName: '客户' },
      ACTOR,
    );
    expect(order.orderedAt).toBe('2026-08-07');
    expect(order.orderedAt.slice(0, 7)).toBe('2026-08');
  });

  it('后补备注：备注缺失不影响保存，可后补填写', () => {
    const { orderService } = setup();
    const order = orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-303', engineer: '工程师', customerName: '客户' },
      ACTOR,
    );
    expect(order.note).toBeNull();

    const updated = orderService.updateNote(order.id, '认证说明', ACTOR);
    expect(updated.note).toBe('认证说明');
  });
});

describe('开单与进单独立（3.9）', () => {
  it('开单不影响项目进单状态与主状态', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    const beforeStatus = project.status;
    const beforeEntryAt = project.entryAt;

    orderService.recordOrder(
      {
        orderType: 'relocation',
        serviceOrderNo: 'ORD-400',
        engineer: '工程师',
        customerName: '客户',
        projectId: project.id,
      },
      ACTOR,
    );
    // 项目实体未被修改（开单不改变进单状态与主状态）
    expect(project.status).toBe(beforeStatus);
    expect(project.entryAt).toBe(beforeEntryAt);
  });

  it('一个项目可关联多条开单', () => {
    const { orderService, projects, orders } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-401', engineer: '工程师甲', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-402', engineer: '工程师乙', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    expect(orders.listByProject(project.id)).toHaveLength(2);
  });
});

describe('项目向导选填单号自动创建开单记录（3.10）', () => {
  it('填写选填单号且已选工程师：项目与开单同次保存，开单关联该项目', () => {
    const { projects, orders, wizard } = setup();
    const project = createPendingProject();

    const result = wizard.save(
      { project, engineers: ['工程师甲'], serviceOrderNo: 'ORD-500', customerName: '华东医药' },
      ACTOR,
    );

    expect(projects.findById(project.id)?.id).toBe(project.id); // 项目已保存
    expect(result.order).not.toBeNull();
    const order = orders.findById(result.order!.id)!;
    expect(order.orderType).toBe('relocation');
    expect(order.serviceOrderNo).toBe('ORD-500');
    expect(order.projectId).toBe(project.id);
    expect(order.engineer).toBe('工程师甲');
    expect(order.customerName).toBe('华东医药');
  });

  it('填写单号但未选定工程师：拒绝保存整个向导（项目与开单均不产生）', () => {
    const { projects, orders, wizard } = setup();
    const project = createPendingProject();

    expect(() =>
      wizard.save(
        { project, engineers: [], serviceOrderNo: 'ORD-501', customerName: '华东医药' },
        ACTOR,
      ),
    ).toThrow(/参与工程师.*必填/);

    expect(projects.findById(project.id)).toBeUndefined(); // 项目不保存
    expect(orders.all).toHaveLength(0); // 开单不产生
  });

  it('开单时间默认当前时间，备注可空并在后补', () => {
    const { wizard } = setup();
    const project = createPendingProject();
    const result = wizard.save(
      { project, engineers: ['工程师甲'], serviceOrderNo: 'ORD-502', customerName: '华东医药' },
      ACTOR,
    );
    expect(result.order!.orderedAt).toBe('2026-08-07');
    expect(result.order!.note).toBeNull();
  });

  it('不填写选填单号不创建任何开单记录', () => {
    const { projects, orders, wizard } = setup();
    const project = createPendingProject();

    const result = wizard.save(
      { project, engineers: ['工程师甲'], serviceOrderNo: null, customerName: '华东医药' },
      ACTOR,
    );

    expect(projects.findById(project.id)?.id).toBe(project.id); // 项目按向导规则保存
    expect(result.order).toBeNull();
    expect(orders.all).toHaveLength(0);
  });

  it('同项目仍可手工关联多条开单', () => {
    const { orders, wizard, orderService } = setup();
    const project = createPendingProject();
    wizard.save(
      { project, engineers: ['工程师甲'], serviceOrderNo: 'ORD-503', customerName: '华东医药' },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-504', engineer: '工程师乙', customerName: '华东医药', projectId: project.id },
      ACTOR,
    );
    expect(orders.listByProject(project.id)).toHaveLength(2);
  });

  it('向导自动创建的开单受服务单号全局唯一约束', () => {
    const { orders, wizard } = setup();
    const first = createPendingProject();
    wizard.save(
      { project: first, engineers: ['工程师甲'], serviceOrderNo: 'ORD-505', customerName: '客户' },
      ACTOR,
    );
    const second = createPendingProject();
    expect(() =>
      wizard.save(
        { project: second, engineers: ['工程师乙'], serviceOrderNo: 'ORD-505', customerName: '客户' },
        ACTOR,
      ),
    ).toThrow(UniquenessError);
    expect(orders.all).toHaveLength(1); // 第二次保存整体未写入
  });
});

describe('开单工作量计数（3.9）', () => {
  it('同一服务单只计一次（服务单号唯一，关联多名工程师/多次上门仍只计一次）', () => {
    const { orders, wizard } = setup();
    // 同一服务单 ORD-600：第一次自动创建关联工程师甲，第二次以相同单号被拒绝
    // （唯一空间），故该服务单在全库仅一条 → 工作量只计一次
    const project = createPendingProject();
    wizard.save(
      { project, engineers: ['工程师甲', '工程师乙'], serviceOrderNo: 'ORD-600', customerName: '客户' },
      ACTOR,
    );
    expect(orders.all).toHaveLength(1);

    const counts = new ServiceOrderService(orders, undefined, CLOCK).countWorkload();
    const relocation = counts.find((c) => c.orderType === 'relocation');
    expect(relocation?.count).toBe(1);
  });

  it('不同服务单分别计数并按四类业务分组', () => {
    const { orderService, projects } = setup();
    const project = createPendingProject();
    projects.save(project);
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-700', engineer: '工程师甲', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'relocation', serviceOrderNo: 'ORD-701', engineer: '工程师乙', customerName: '客户', projectId: project.id },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'certification', serviceOrderNo: 'ORD-702', engineer: '工程师丙', customerName: '客户' },
      ACTOR,
    );
    orderService.recordOrder(
      { orderType: 'pm', serviceOrderNo: 'ORD-703', engineer: '工程师丁', customerName: '客户' },
      ACTOR,
    );

    const counts = orderService.countWorkload();
    expect(counts.find((c) => c.orderType === 'relocation')?.count).toBe(2);
    expect(counts.find((c) => c.orderType === 'certification')?.count).toBe(1);
    expect(counts.find((c) => c.orderType === 'pm')?.count).toBe(1);
    expect(counts.find((c) => c.orderType === 'parts_by_mail')).toBeUndefined();
  });
});
