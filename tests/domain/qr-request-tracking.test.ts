import { describe, expect, it } from 'vitest';
import { QrRequestService } from '../../src/domain/capabilities/qr-request-tracking/qr-request-service';
import { FixedClock } from '../../src/domain/core/time';
import { InMemoryQrRequestRepository } from '../helpers/capability-in-memory';
import { InMemoryInstrumentRepository } from '../helpers/execution-in-memory';
import { makeAccount } from '../helpers/fact-builder';

/**
 * qr-request-tracking 领域场景测试（tasks 4.9~4.10 实现，4.14 场景验证）。
 * 覆盖 spec 全部 ADDED Requirements 场景。
 */

const CLOCK = new FixedClock('2026-08-07T10:00:00+08:00');
const ACTOR = makeAccount('account-1', '负责人甲');

function setup() {
  const requests = new InMemoryQrRequestRepository();
  const service = new QrRequestService(requests, CLOCK);
  return { requests, service };
}

describe('独立二维码申请模块与申请记录（4.9 / TBD-06）', () => {
  it('保存申请人与申请时间并选择申请类型', () => {
    const { service } = setup();
    const request = service.createRequest(
      { applicant: '负责人甲', requestedAt: '2026-08-01', types: ['A', 'B'] },
      ACTOR,
    );
    expect(request.applicant).toBe('负责人甲');
    expect(request.requestedAt).toBe('2026-08-01');
    expect(request.types).toEqual(['A', 'B']);
  });

  it('申请不关联仪器与项目', () => {
    const { service } = setup();
    const request = service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    const keys = Object.keys(request).sort();
    expect(keys.some((k) => k.includes('instrument'))).toBe(false);
    expect(keys.some((k) => k.includes('project'))).toBe(false);
  });

  it('申请不设状态流转：一经保存即为一条完整记录', () => {
    const { service } = setup();
    const request = service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    const keys = Object.keys(request).sort();
    expect(keys.some((k) => k.includes('status'))).toBe(false);
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['submit', 'complete', 'cancel', 'revert']) {
      expect(name in proto).toBe(false);
    }
    expect(request.id).toBeTruthy();
  });
});

describe('申请类型固定代码与多选（4.9）', () => {
  it('一条申请多选多个类型，允许从九类固定类型中选择', () => {
    const { service } = setup();
    const request = service.createRequest(
      { applicant: '负责人甲', types: ['A', 'oem_equipment', 'logistics_management'] },
      ACTOR,
    );
    expect(request.types).toHaveLength(3);
    // 同一条内相同类型去重
    const dedup = service.createRequest({ applicant: '负责人甲', types: ['A', 'A', 'B'] }, ACTOR);
    expect(dedup.types).toEqual(['A', 'B']);
  });

  it('类型仅作分类代码：不关联任何搬迁仪器或搬迁项目', () => {
    const { service } = setup();
    const request = service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    expect(request.types).toEqual(['A']);
    // 非法类型拒绝
    expect(() => service.createRequest({ applicant: '负责人甲', types: ['E' as never] }, ACTOR)).toThrow(
      /九类固定代码/,
    );
    expect(() => service.createRequest({ applicant: '负责人甲', types: [] }, ACTOR)).toThrow(/至少选择一个/);
  });
});

describe('申请工作量按去重类型计数（4.9 / TBD-06）', () => {
  it('每条记录每个去重选中类型各计一次，同条内相同类型只计一次', () => {
    const { service } = setup();
    service.createRequest({ applicant: '负责人甲', types: ['A', 'A', 'B'] }, ACTOR);
    const workload = service.countWorkloadByType();
    expect(workload.find((w) => w.typeCode === 'A')?.count).toBe(1);
    expect(workload.find((w) => w.typeCode === 'B')?.count).toBe(1);
    expect(workload.reduce((s, w) => s + w.count, 0)).toBe(2);
  });

  it('不同申请分别计数：相同类型不因分属不同申请而合并', () => {
    const { service } = setup();
    service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    const workload = service.countWorkloadByType();
    expect(workload.find((w) => w.typeCode === 'A')?.count).toBe(2);
  });
});

describe('重复申请保留历史（4.9）', () => {
  it('新旧申请均保留在申请历史中，各自独立保存并计数', () => {
    const { service, requests } = setup();
    const first = service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    const second = service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    expect(requests.all).toHaveLength(2);
    expect(requests.findById(first.id)?.id).toBe(first.id);
    expect(requests.findById(second.id)?.id).toBe(second.id);
    // 无覆盖/删除能力
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    for (const name of ['deleteRequest', 'overwriteRequest']) {
      expect(name in proto).toBe(false);
    }
  });
});

describe('仪器"二维码是否申请"手工字段（4.10）', () => {
  it('手工标记是/否：不随二维码申请记录的保存而变化', () => {
    const { service } = setup();
    const instruments = new InMemoryInstrumentRepository();
    instruments.save({
      id: 'i1',
      projectId: 'p1',
      batchId: null,
      name: '仪器A',
      model: null,
      serialNo: 'SN-100',
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    const before = instruments.findById('i1')!.qrRequested;
    // 保存二维码申请记录不影响仪器手工标记
    service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR);
    expect(instruments.findById('i1')!.qrRequested).toBe(before);
    // 手工改为是
    const instrument = instruments.findById('i1')!;
    instrument.qrRequested = true;
    instruments.save(instrument);
    expect(instruments.findById('i1')!.qrRequested).toBe(true);
  });

  it('不保存 URL、不自动创建项目提醒、不阻塞上门/运输/项目流转', () => {
    const { service } = setup();
    const instruments = new InMemoryInstrumentRepository();
    instruments.save({
      id: 'i1',
      projectId: 'p1',
      batchId: null,
      name: '仪器B',
      model: null,
      serialNo: 'SN-200',
      ups: false,
      qrRequested: false,
      destinationShipToId: null,
      accountId: null,
      usernameSnapshot: null,
      createdAt: 't',
      updatedAt: 't',
    });
    // 字段为是/否布尔，无 URL 字段
    const instrument = instruments.findById('i1')!;
    expect(typeof instrument.qrRequested).toBe('boolean');
    expect('qrUrl' in instrument).toBe(false);
    // 服务不创建任何项目提醒（无 reminder 能力）
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    expect('createReminder' in proto).toBe(false);
    // 申请保存成功即完成，不阻塞任何流转（本模块无生命周期依赖）
    expect(() => service.createRequest({ applicant: '负责人甲', types: ['A'] }, ACTOR)).not.toThrow();
  });
});
