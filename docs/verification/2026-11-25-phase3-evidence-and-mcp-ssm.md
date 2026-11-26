# Phase 3 실증 기록: 무검토 변경 요약 보강 · AWS SSM MCP 연결 검증 · EC2 Spot 평가

- **검증 일시:** 2026-11-25 (KST 19:50–19:55)
- **관련 이슈 / 기준 문서:** [Issue #9](https://github.com/roboco-io/project-hivemind/issues/9), [Milestone 1 실증 기록](2026-11-25-milestone1-unattended-draft-pr.md), [AWS 단일 실행 마스터 플랜](../plans/2026-11-25-realignment-aws-plan.md)

---

## 1. 무검토 판단 근거 보강 (`DeliveryChangeSummary`)

Milestone 1B에서 운영자가 diff 미열람(`openedDiff: false`) 30초 만에 [PR #10](https://github.com/roboco-io/project-hivemind/pull/10)을 승인·병합하면서 남긴 핵심 피드백(*"변경사항에 대해서 좀 더 자세한 요약이 필요함."*)을 코드와 PR 템플릿에 즉시 반영했습니다.

- **계약 및 중앙 저장소 (`packages/contracts/src/delivery.ts`, `packages/core/src/delivery.ts`):**
  - `ChangedFileStat`, `DeliveryChangeSummary` 계약 추가 및 `DeliveryTask.latestWorkerSummary`, `DraftPrPublication.changeSummary` 영속화(`BEGIN IMMEDIATE` 트랜잭션, 경로 정규화·크기 제한 검증).
- **신뢰된 Git 메타데이터 통계 (`packages/adapters/src/git-bundle.ts`):**
  - `computePatchTreeHash()`가 비신뢰 코드를 실행하지 않고 `git apply --numstat`으로 정확한 변경 파일 목록·추가/삭제 줄 수·바이너리 여부를 `prTreeHash`와 함께 산출.
- **Draft PR 본문 확장 (`packages/adapters/src/draft-pr-publisher.ts`):**
  - `3. 변경사항 상세 요약 (diff 미열람 판단용)` 섹션 자동 삽입:
    - 총 변경 파일 수 및 `+추가 / -삭제` 규모
    - 정책 준수 체크리스트(격리 브랜치, `autoMerge: false`, 수용 테스트 무변조, `verifiedTreeHash === prTreeHash`)
    - 파일별 변경 내역 표(최대 50행 + 초과 생략 표기)
    - 비밀 가림(`redactText`)이 적용된 워커 구현 요약(비신뢰 참고임을 명시하고 독립 검증 결과와 분리 표기)
- **워커 최종 요약 규격화 (`apps/worker/src/aws-worker-main.ts`):**
  - Codex/Claude 프롬프트에 `변경 파일별 요약`, `핵심 동작 변화`, `자체 확인 결과` 3항목 최종 응답 규격을 추가해 `POST /api/delivery/tasks/:id/worker-completed`로 자동 전달.

---

## 2. 실제 AWS Control Plane ↔ MCP(`HIVEMIND_MCP_PROFILE=delivery`) SSM 연결 검증

`scripts/aws-ssm-mcp-verify.ts`로 실제 `@modelcontextprotocol/sdk/client`가 `dist/apps/mcp-server/src/main.js` (`HIVEMIND_MCP_PROFILE=delivery`)를 stdio로 띄우고, **AWS SSM 포트 포워딩 터널**을 통해 라이브 `ControlPlaneService` (`ap-northeast-2`, 퍼블릭 인바운드 CIDR 0개)에 접속하는 종단 검증을 완료했습니다.

| 검증 항목 | 실측 결과 |
| --- | --- |
| 노출 도구 프로필 / 개수 | `delivery` / **6개** (`hivemind_delivery_create`, `approve`, `list`, `get`, `human_decision`, `cancel`) |
| `hivemind_delivery_list` 조회 | 성공 (AWS EFS SQLite 영속 작업 2건 반환) |
| `hivemind_delivery_get` 조회 | 성공 (`dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3`, `status: "approved"`, `prUrl: .../pull/10`, `treeHashMatch: true`, `openedDiff: false`, `durationMinutes: 0.5`) |
| 운영자 토큰 노출 여부 | **`operatorTokenLeaked: false`** |

> 참고: Codex / Claude Code 데스크톱 앱 UI(GUI)에서의 수동 대화 확인은 앱 세션에서 위 `apps/mcp-server/README.md`의 SSM 터널 + `HIVEMIND_MCP_PROFILE=delivery` 설정으로 즉시 연결할 수 있습니다.

---

## 3. 2단계 EC2 Spot 검증 워커 평가 결론

- **실측 근거:** `project-hivemind` 전체 저장소(636–790 파일, 7.24–7.71 MB `git bundle`)의 TypeScript 빌드 + API 수용 테스트가 1단계 `FARGATE_SPOT` (ARM64 4 vCPU / 8 GiB)에서 **8.0초**(워커+검증기 합계 159초, 추정 컴퓨트 비용 **약 $0.0025**)로 완료됨.
- **결론:** 현재 SW 개발 워크로드에서는 **2단계 EC2 Spot을 도입하지 않고 보류(Deferred)** 하는 것이 비용·운영 복잡도·격리 보안 면에서 명백히 유리함. 향후 C++/Rust 대형 빌드(예: DuckDB급)에서 Fargate 최대 스펙(16 vCPU / 120 GiB / 200 GiB) 또는 로컬 캐시 부재가 병목으로 실측될 때만 기존 `infrastructure/aws-external-guard` TTL Guard 패턴으로 2단계 EC2 Spot을 추가함.

---

## 4. 자동 테스트 검증

- 루트 `npm run check`: **1,207 / 1,207 통과** (0 실패, 0 스킵) — `DeliveryChangeSummary` E2E 및 API 검증 포함
- `infrastructure/aws-runtime` (`npm run typecheck && npm test`): **3 / 3 통과**
