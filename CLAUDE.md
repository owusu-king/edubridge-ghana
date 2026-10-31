# EduBridge Ghana — Project Engineering Rules

## 1. Project identity

EduBridge is a premium, multi-tenant School Management and Education Operations SaaS platform.

Primary market: Ghana.
Future markets: Africa and international schools.

The initial product is a responsive web application and installable PWA, with future Android and iOS applications.

Build for real paying customers, not demonstrations.

## 2. Engineering standards

- Use TypeScript with strict type checking.
- Prioritize maintainable, readable code.
- Follow modular architecture and clear separation of concerns.
- Keep business logic separate from UI components.
- Avoid duplicated code and unnecessary abstractions.
- Use reusable components and consistent design patterns.
- Document important architectural decisions.
- Never introduce dependencies without a good reason.

## 3. Architecture principles

- Start with a modular monolith.
- Use PostgreSQL as the primary database.
- Maintain clear domain boundaries.
- Design secure, reusable APIs.
- Enforce tenant isolation at the server and database levels.
- Use proper database migrations.
- Maintain financial transaction integrity.
- Design for future React Native applications.
- Avoid premature microservices.

## 4. Security requirements

- Never expose secrets or API keys.
- Never commit environment files containing credentials.
- Enforce authorization on the server.
- Validate all external inputs.
- Protect student, guardian and financial records.
- Maintain audit trails for sensitive operations.
- Never bypass tenant authorization.
- Use synthetic data for development and testing.

## 5. Design requirements

EduBridge must look and feel like premium international enterprise software.

Prioritize:
- Timeless visual design.
- Exceptional typography.
- Consistent spacing.
- Restrained colors.
- Elegant data visualization.
- Excellent mobile responsiveness.
- Accessible interfaces.
- Clear navigation.
- Thoughtful empty, loading and error states.

Avoid:
- Generic AI-generated dashboard designs.
- Excessive gradients.
- Unnecessary card layouts.
- Decorative animations.
- Inconsistent components.
- Fake statistics.
- Placeholder functionality presented as complete.

Every screen must have a clear purpose.

## 6. Development workflow

Before implementing significant functionality:

1. Inspect the existing codebase.
2. Understand the existing architecture.
3. Explain the implementation approach.
4. Identify affected modules.
5. Consider security and permissions.
6. Identify necessary tests.

After implementation:

1. Run relevant tests.
2. Run TypeScript checks.
3. Run linting.
4. Review regressions.
5. Update documentation.
6. Report remaining limitations.

Never claim that tests passed unless they were actually executed.

## 7. Financial integrity

Financial functionality requires exceptional care.

- Use appropriate decimal precision.
- Never silently overwrite completed transactions.
- Support reversals and adjustments.
- Implement idempotent payment processing.
- Verify payment provider responses.
- Preserve transaction histories.
- Reconcile payments against actual financial records.

## 8. Project management

- Work incrementally.
- Maintain a clear development roadmap.
- Do not implement every module at once.
- Do not rewrite working functionality unnecessarily.
- Preserve existing Git history.
- Do not perform destructive operations without approval.
- Do not deploy or incur paid infrastructure costs without approval.

## 9. Founder approval

I am the product owner.

Ask for approval before:
- Major architectural changes.
- Destructive database operations.
- Introducing significant paid services.
- Deploying to production.
- Making irreversible changes.

Challenge weak technical decisions and recommend better alternatives.

## 10. Current development stage

Current stage: Phase 0 — Product discovery and architecture.

Do not start building application functionality until the founder approves the architecture and roadmap.

The immediate objective is to produce comprehensive architecture and product documentation under `/docs`.

Always prioritize product quality, security, maintainability and commercial viability.