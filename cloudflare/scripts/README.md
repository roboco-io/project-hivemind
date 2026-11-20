# scripts

## Overview

이 폴더는 Cloudflare 프로젝트 수준의 스크립트를 묶는다. 현재 하위 폴더는 0단계 타당성 검증용 `phase0` 하나다.
백엔드 운영자 스크립트는 이 폴더가 아니라 [backend/scripts](../backend/scripts/README.md)에 있다.

## Subdirectories & Boundaries

- phase0: [./phase0/README.md](./phase0/README.md) - 공식 Codex·Claude Code CLI의 컨테이너 실행과 파일·프로세스·인증 경계를 확인하는 probe, 판정 로직, 운영자 스크립트. 하위 `cloudflare`는 probe를 실행하는 Worker다.
