# Zacma interface improvement plan

The approved scope preserves the existing Express/MySQL backend, Firebase configuration, and all production data. No database migration or backend workflow replacement is included.

Inspection identified an existing static interface with role-specific administration and accounting navigation, registration and payment approval flows, receipt printing, attendance, messaging, reporting, settings, and AI assistance. Those DOM contracts and API calls must remain intact. React packages are installed, but rewriting all workflow controllers at once would risk existing functionality; incremental migration remains a later task.

1. Apply a shared navy, white, and blue design system across existing pages, forms, tables, dialogs, and public registration.
2. Improve the authentication experience and dashboard hierarchy without inventing statistics.
3. Group existing role-specific navigation, provide accessible menu search and collapsible groups, and retain authorization boundaries.
4. Add light/dark appearance controls, mobile refinements, keyboard access, and reduced-motion support.
5. Correct the static output directory and preserve the existing backend integration.
6. Verify syntax, navigation targets, DOM identifiers, and UI interactions without modifying production records.

The existing MySQL/Firebase split, backend deployment, authentication redesign, new ERP modules, and production security guarantees require separate implementation and integration validation. UI changes do not establish server-side permissions or make missing backend features available.
