SHELL := /bin/bash
.DEFAULT_GOAL := help

OPERATOR_TOKEN_FILE ?= $(HOME)/.hivemind/aws-operator-token.json
AWS_PROFILE ?= roboco
HIVEMIND_AWS_REGION ?= ap-northeast-2
HIVEMIND_ECS_CLUSTER ?= hivemind-runtime-cluster
HIVEMIND_CONTROL_PLANE_SERVICE ?= hivemind-runtime-control-plane
HIVEMIND_LOCAL_PORT ?= 4310

.PHONY: help token operator-token open tunnel-stop aws-status aws-up aws-down aws-tunnel check

help: ## 사용 가능한 명령어 목록 표시
	@printf "HIVEMIND 운영 단축 명령어\n\n"
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  make %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

token: operator-token ## operator-token 별칭

open: ## 터널이 닫혀 있으면 자동 재연결 감시기로 열고, #token 프래그먼트로 관제실 브라우저 열기
	@AWS_PROFILE="$(AWS_PROFILE)" \
		HIVEMIND_AWS_REGION="$(HIVEMIND_AWS_REGION)" \
		HIVEMIND_ECS_CLUSTER="$(HIVEMIND_ECS_CLUSTER)" \
		HIVEMIND_CONTROL_PLANE_SERVICE="$(HIVEMIND_CONTROL_PLANE_SERVICE)" \
		HIVEMIND_LOCAL_PORT="$(HIVEMIND_LOCAL_PORT)" \
		OPERATOR_TOKEN_FILE="$(OPERATOR_TOKEN_FILE)" \
		node --import ./infrastructure/aws-runtime/node_modules/tsx/dist/loader.mjs scripts/aws-open-dashboard.ts

tunnel-stop: ## make open 이 실행한 백그라운드 SSM 터널 감시기 종료
	@HIVEMIND_LOCAL_PORT="$(HIVEMIND_LOCAL_PORT)" \
		node --import ./infrastructure/aws-runtime/node_modules/tsx/dist/loader.mjs scripts/aws-open-dashboard.ts --stop

operator-token: ## AWS 운영자 토큰을 화면 출력 없이 클립보드에 복사
	@set -euo pipefail; \
	if [[ ! -f "$(OPERATOR_TOKEN_FILE)" ]]; then \
		echo "오류: $(OPERATOR_TOKEN_FILE) 파일이 없습니다. 먼저 npm run bootstrap 을 확인하세요." >&2; \
		exit 1; \
	fi; \
	if [[ -n "$${CLIPBOARD_CMD:-}" ]]; then \
		CLIP="$$CLIPBOARD_CMD"; \
	elif command -v pbcopy >/dev/null 2>&1; then \
		CLIP="pbcopy"; \
	elif command -v wl-copy >/dev/null 2>&1; then \
		CLIP="wl-copy"; \
	elif command -v xclip >/dev/null 2>&1; then \
		CLIP="xclip -selection clipboard"; \
	elif command -v xsel >/dev/null 2>&1; then \
		CLIP="xsel --clipboard --input"; \
	else \
		echo "오류: 클립보드 명령(pbcopy/wl-copy/xclip/xsel)을 찾을 수 없습니다." >&2; \
		exit 1; \
	fi; \
	TOKEN_FILE="$(OPERATOR_TOKEN_FILE)" node -e ' \
		const fs = require("node:fs"); \
		const raw = JSON.parse(fs.readFileSync(process.env.TOKEN_FILE, "utf8")); \
		if (typeof raw?.OPERATOR_TOKEN !== "string" || !raw.OPERATOR_TOKEN.trim()) { \
			console.error("오류: OPERATOR_TOKEN 필드가 비어 있거나 올바르지 않습니다."); \
			process.exit(1); \
		} \
		process.stdout.write(raw.OPERATOR_TOKEN.trim()); \
	' | eval "$$CLIP"; \
	echo "운영자 토큰을 클립보드에 복사했습니다 (화면에 출력하지 않음)."

aws-status: ## AWS Control Plane ECS 서비스 상태 조회 (읽기 전용)
	@aws --profile "$(AWS_PROFILE)" --region "$(HIVEMIND_AWS_REGION)" ecs describe-services \
		--cluster "$(HIVEMIND_ECS_CLUSTER)" \
		--services "$(HIVEMIND_CONTROL_PLANE_SERVICE)" \
		--query 'services[0].{status:status,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount}' \
		--output json

aws-up: ## AWS Control Plane 기동 (desiredCount=1, 과금 시작)
	@aws --profile "$(AWS_PROFILE)" --region "$(HIVEMIND_AWS_REGION)" ecs update-service \
		--cluster "$(HIVEMIND_ECS_CLUSTER)" \
		--service "$(HIVEMIND_CONTROL_PLANE_SERVICE)" \
		--desired-count 1 \
		--query 'service.{status:status,desiredCount:desiredCount,runningCount:runningCount}' \
		--output json
	@aws --profile "$(AWS_PROFILE)" --region "$(HIVEMIND_AWS_REGION)" ecs wait services-stable \
		--cluster "$(HIVEMIND_ECS_CLUSTER)" \
		--services "$(HIVEMIND_CONTROL_PLANE_SERVICE)"
	@echo "AWS Control Plane 기동 완료."

aws-down: ## 백그라운드 터널 정리 후 AWS Control Plane 종료 (desiredCount=0, 유휴 과금 중지)
	@$(MAKE) --no-print-directory tunnel-stop
	@aws --profile "$(AWS_PROFILE)" --region "$(HIVEMIND_AWS_REGION)" ecs update-service \
		--cluster "$(HIVEMIND_ECS_CLUSTER)" \
		--service "$(HIVEMIND_CONTROL_PLANE_SERVICE)" \
		--desired-count 0 \
		--query 'service.{status:status,desiredCount:desiredCount,runningCount:runningCount}' \
		--output json
	@echo "AWS Control Plane 종료 요청 완료 (desiredCount=0)."

aws-tunnel: ## AWS Control Plane으로 로컬 SSM 포트 포워딩 터널 열기 (http://127.0.0.1:4310)
	@AWS_PROFILE="$(AWS_PROFILE)" \
		HIVEMIND_AWS_REGION="$(HIVEMIND_AWS_REGION)" \
		HIVEMIND_ECS_CLUSTER="$(HIVEMIND_ECS_CLUSTER)" \
		HIVEMIND_CONTROL_PLANE_SERVICE="$(HIVEMIND_CONTROL_PLANE_SERVICE)" \
		HIVEMIND_LOCAL_PORT="$(HIVEMIND_LOCAL_PORT)" \
		node --import ./infrastructure/aws-runtime/node_modules/tsx/dist/loader.mjs scripts/aws-ssm-tunnel.ts

check: ## 타입 검사, 빌드 및 전체 자동 테스트 실행
	@npm run check
