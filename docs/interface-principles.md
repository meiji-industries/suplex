# Forge interface principles

Forge is an application, not a webpage. The interface should feel like a
desktop productivity tool: persistent navigation, compact toolbars, dense
lists, fast context, and minimal visual ceremony. Use Linear and Paperclip as
references for information architecture and interaction patterns, not as
decoration to imitate.

## Density

- Body text is normally 13px.
- Secondary text is 12px.
- View labels and list-group labels are 11–13px with medium weight.
- Standard controls are 28px high; larger controls are 32px.
- List rows are 32–36px high, with detail panels kept compact.
- Icons are 14–16px.
- Typical radii are 5–6px; large surfaces are at most 8px.
- Use the available viewport. Avoid centering a small dashboard inside a wide
  empty page.

## Surfaces

Prefer low-contrast borders, background changes, spacing, and typography over
cards and shadows. A card needs semantic meaning; it is not the default
container for a section or row. Avoid gradients, decorative shadows, and
large rounded containers.

## Layout

Use an application shell:

```text
sidebar | primary workspace | optional inspector
```

The sidebar is persistent on desktop and compact on narrow screens. The
primary workspace should be made of toolbars, tabs, lists, tables, and
expandable rows rather than hero sections or dashboard tiles.

## Interaction

- Prefer inline expansion, popovers, contextual menus, and hover-revealed
  actions over modal workflows.
- Make keyboard focus visible and preserve native semantics.
- Use buttons for actions and links for navigation.
- Animations communicate state only and should generally last 120–180ms.
- Do not add decorative motion or bounce.

## Hierarchy and language

Use muted foreground colors extensively. Reserve high contrast for the current
view, selected items, and important labels. Use accent colors sparingly for
status and actions.

Do not write marketing-style headlines, subheadings, captions, or explanatory
lede copy in product views. A compact view label, status, endpoint, and
actionable data are enough. Prefer `Host health`, `Ready`, and `6 checks` over
hero copy such as `Truthful readiness.` or explanatory paragraphs.

## Component vocabulary

Build the product language in reusable components under
`src/frontend/components/ui` and, as the product grows, application primitives
under `src/frontend/components/app`:

- `AppSidebar`
- `SidebarItem`
- `DataRow` / `DataList`
- `StatusIndicator`
- `DetailPane`
- `EmptyState`
- `InlineEditor`
- `CommandMenu`

When a new surface needs one of these behaviors, extend the existing primitive
instead of creating a one-off rounded card.

## Visual validation

For frontend changes:

1. Build and run the application.
2. Inspect the real route with Playwright at desktop and narrow viewports.
3. Check density, hierarchy, spacing, controls, and interaction states.
4. Fix visual discrepancies before declaring the work complete.
