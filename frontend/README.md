# frontend/

React + TypeScript client for the e-commerce platform.

**Status: not yet scaffolded.** The frontend is deliberately out of scope for
Day 1 (backend foundation + database schema). It will be initialized with
React + TypeScript (Vite) in a later stage, once the backend API provides
something real for it to talk to.

Planned structure (subject to change):

```
frontend/
  src/
    api/        # typed API client
    components/ # UI components
    pages/      # route-level pages
    hooks/      # shared hooks
    types/      # shared types mirrored from backend
  ...
```