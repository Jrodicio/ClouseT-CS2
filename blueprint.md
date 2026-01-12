# Project Blueprint

## Overview
Angular + Firebase app for organizing CS2 matches with automated orchestration, leader selection, map veto, and server start workflows backed by Cloud Functions and Firestore.

## Current Features
- Match state stored in Firestore with queueing, team assignment, map selection, and finalization flows.
- Cloud Functions HTTP API for auth, match lifecycle, and match JSON retrieval.
- Server automation via Pterodactyl command API to start matches when ready.

## Current Change Plan
1. Use a public base URL (configurable via `PUBLIC_BASE_URL`) to build `/api/match/config` for match configs.
2. Update match start flow to load match config via `/api/match/config` instead of signed JSON storage URLs.
