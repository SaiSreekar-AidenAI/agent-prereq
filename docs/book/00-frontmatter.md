# How Coding Agents Work {: #cover .nobreak }

<p class="subtitle">An Architecture Handbook — distilled from five production agents</p>
<p class="covermeta">claude-code &middot; opencode &middot; openclaude &middot; codex &middot; goose<br/>reverse-engineered from source, with file:line citations throughout</p>

# Contents

- [Introduction](#introduction)

**Part I — The Core**

- [1. The Agent Loop](#1-the-agent-loop)
- [2. Messages, Blocks & Conversation State](#2-messages-blocks-conversation-state)
- [3. The Tool System](#3-the-tool-system)
- [4. The Model & Provider Layer](#4-the-model-provider-layer)
- [5. Prompt Construction & Caching](#5-prompt-construction-caching)
- [6. Context Management & Compaction](#6-context-management-compaction)

**Part II — Control & Safety**

- [7. Permissions, Approval & Sandboxing](#7-permissions-approval-sandboxing)
- [8. Hooks](#8-hooks)
- [9. Memory & Context Files](#9-memory-context-files)

**Part III — Extensibility**

- [10. Skills](#10-skills)
- [11. Slash & Custom Commands](#11-slash-custom-commands)
- [12. Output Styles](#12-output-styles)
- [13. Subagents & Orchestration](#13-subagents-orchestration)
- [14. MCP (Model Context Protocol)](#14-mcp-model-context-protocol)

**Part IV — Runtime**

- [15. Sessions, Persistence, Todos & Background Tasks](#15-sessions-persistence-todos-background-tasks)

**Part V — Building It**

- [16. End-to-End Scenarios](#16-end-to-end-scenarios)
- [17. The Lean Build](#17-the-lean-build)

# Introduction

This handbook explains how a modern coding agent actually works — not the marketing
view, the wiring. It is reverse-engineered from five real codebases and written for
one purpose: so you can build your own lean agent framework and know exactly which
parts are load-bearing and which are product decoration.

## The mental model

An agent is a **loop around a language model that can call tools**. The model never
touches your machine directly; it can only *propose* actions as structured
`tool_use` requests. The harness executes those actions, feeds the results back as
the next message, and asks the model again. This repeats until the model stops
requesting tools. That is the whole idea:

```text
messages = [ user(task) ]
loop:
    reply   = model(system_prompt, tools, messages)   # the model proposes
    messages.append(assistant(reply))
    calls   = [ b for b in reply.content if b.type == "tool_use" ]
    if calls is empty:            # <- the model asked for nothing => it is done
        return reply
    results = [ run_with_permission(c) for c in calls ]   # the harness acts
    messages.append(user(results))                        # feed results back
```

Everything else in this book — streaming, context compaction, skills, hooks,
subagents, MCP, sandboxes, sessions — is an elaboration of those ten lines.

## The word for it: the "harness"

That surrounding loop-plus-tools-plus-context machinery has a name that is suddenly
everywhere: the **agent harness**. The framing worth internalizing is a small
equation — **Agent = Model + Harness**. The model is the interchangeable brain; the
harness is everything in this book that turns it into something that acts. The
leaked Claude Code source described itself as exactly that: *"the skeleton not the
brain."*

The term is trending because of a backlash toward **minimal** harnesses. Once you
separate the two halves, you notice most frameworks over-scaffold — giant system
prompts and dozens of tools that actually degrade the model by crowding its context.
The current exemplar, **pi.dev**, strips the harness to four tools
(`read/write/edit/bash`) and a system prompt under 1,000 tokens, then lets you
*extend it by writing code the agent loads into itself* (Ch. 3, 5, 17). Keep that
lens while reading: for every component here, ask "is this the kernel, or is it
weight?"

## The convergence thesis

Five independently built agents — two of them in Rust, three in TypeScript —
converge on the **same kernel**: a `while(true)` turn loop, a `{name, JSON-schema,
call}` tool abstraction, a streaming provider call with tool-call extraction,
threshold-triggered context compaction, and an allow/ask/deny permission gate. The
other ~95% of each codebase is surface: UIs, telemetry, provider breadth,
enterprise/cloud, and multi-agent choreography. If you build the kernel well, you
have a real agent. This book teaches the kernel first (Part I), then the
genuinely-useful elaborations (Parts II–IV), then how to assemble a lean one (Part V).

## The five sources

| Repo | Lang | Studied for |
|---|---|---|
| `claude-code` | TS (leaked) | the canonical architecture; battle-tested loop ergonomics |
| `opencode` | TS | cleanest modern structure; persistence-as-source-of-truth |
| `openclaude` | TS | multi-provider via a canonical-format shim |
| `codex` | Rust | strongest safety: real OS sandbox; typed protocol |
| `goose` | Rust | MCP as the universal tool bus; dual message visibility |

## Seven laws that recur in every chapter

1. **The exit signal is the absence of a `tool_use` block — not the provider's
   `stop_reason`.** Four of five repos explicitly distrust `stop_reason`.
2. **Everything is a tool result.** Validation failures, permission denials, and
   tool exceptions are all fed back to the model as `is_error` results, never thrown.
   The loop has one happy path.
3. **The pairing invariant.** Every emitted `tool_use` must get a matching
   `tool_result` before the next model call, or the API rejects the request.
4. **Keep the system-prompt prefix byte-stable** so the provider's prompt cache
   hits; push dynamic facts to the end or into a user message.
5. **Compact at a threshold, don't delete.** Summarize near ~80% of the window and
   rebuild history; mark old turns invisible rather than dropping them.
6. **Gate before side effects.** The permission decision happens before a tool runs,
   not after.
7. **A subagent is just the loop, recursed** with a child context and a filtered
   tool set. There is no separate "agent runtime".

## How to read this

Chapters are self-contained. Each follows the same shape: *what & why → how it works
(with a flow and pseudocode) → in the wild (how the five repos do it, with
`repo/path:line` citations) → a concrete scenario → a lean take.* Citations point
into `repos/<name>/...`; verify any of them by opening the file. Pseudocode is
language-agnostic; real excerpts are labelled by language.

> The `claude-code` repository is a leaked snapshot of Anthropic's proprietary code.
> It is cited here for **understanding patterns only** — re-implement the ideas, do
> not copy its source into your own framework.
