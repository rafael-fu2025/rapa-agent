# Contributing to Rapa

Thank you for your interest in contributing to Rapa! This document provides guidelines and best practices for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Project Conventions](#project-conventions)

## Code of Conduct

We expect all contributors to follow basic respectful behavior. Please be kind, considerate, and constructive in all interactions.

## Getting Started

1. **Fork the repository**
2. **Clone your fork**:
   ```bash
   git clone https://github.com/[your-username]/Recreate-UI.git
   cd "Recreate UI"
   ```
3. **Install dependencies**:
   ```bash
   npm install
   cd server && npm install && cd ..
   ```
4. **Set up environment**:
   ```bash
   cd server
   cp .env.example .env
   # Edit server/.env to set APP_SECRET, DATABASE_URL, etc.
   ```
5. **Initialize the database**:
   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```
6. **Start the development servers**:
   ```bash
   # Terminal 1: Backend
   cd server && npm run dev
   # Terminal 2: Frontend
   npm run dev
   ```

## Development Workflow

### Making Changes

1. Create a new branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes and commit them
3. Push your changes to your fork
4. Open a pull request

### Key Files to Know

- `AGENTS.md`: Comprehensive guide for working with the AI agent codebase
- `README.md`: Project overview and setup guide
- `src/app/routes.tsx`: Frontend route and chat UI orchestration
- `server/src/index.ts`: Backend entry point
- `server/src/lib/agent.ts`: Core agent loop
- `server/prisma/schema.prisma`: Database schema

## Testing

### Running Tests

The project has 373+ tests across frontend and backend:

```bash
# Frontend tests
npm test

# Backend tests
cd server && npm test
```

### Test Requirements

All tests must pass before your pull request is merged. If you're adding a new feature, please include relevant tests.

### Build Verification

Before committing, verify that the builds succeed:

```bash
# Frontend production build
npm run build

# Backend production build
cd server && npm run build
```

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages:

- `feat:`: New feature
- `fix:`: Bug fix
- `refactor:`: Code refactoring without changing functionality
- `docs:`: Documentation only changes
- `test:`: Adding or updating tests
- `chore:`: Changes to build process, dependencies, etc.

Examples:
```
feat: add git_status tool
fix: prevent useEffect from clearing in-flight agent messages
docs: update AGENTS.md for extracted agent modules
```

## Pull Request Process

1. Ensure all tests pass (`npm test` in both root and server)
2. Ensure the builds succeed (`npm run build` in both root and server)
3. Update documentation if needed
4. Open a pull request with a clear title and description
5. Wait for a review and address any feedback

## Project Conventions

- **TypeScript Strict Mode**: No `any`, prefer `unknown` with narrowing
- **Named Exports**: No default exports
- **Type Over Interface**: Use `type` for most type definitions
- **File Naming**: Kebab-case for files, PascalCase for components, camelCase for functions
- **Import Extensions**: Backend uses `.js` extensions for NodeNext module resolution
- **Path Aliases**: Frontend uses `@/` alias for absolute imports
- **Testing**: All new features should include tests
- **Documentation**: All new tools need a doc block in `server/src/lib/agent/tool-docs.ts`

### Before Merging

1. Backend compiles: `cd server && npx tsc --noEmit`
2. Frontend bundles: `npm run build`
3. All tests green: `npm test` and `cd server && npm test`
4. Manual smoke test: Open app, send a chat message, send an agent message, verify file tree
5. No commented-out code or stray `console.log`
6. Migration files reviewed for correctness

## Getting Help

If you have questions, feel free to open an issue or ask in a pull request discussion.

---

Thank you for contributing to Rapa!
