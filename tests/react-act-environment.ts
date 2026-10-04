// Tells React that tests drive renders through act(); without it, every act() call logs a warning.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
