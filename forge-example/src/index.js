import Resolver from '@forge/resolver';

const resolver = new Resolver();

// Basic resolver that simply returns context information.
resolver.define('getContext', (req) => {
  return { context: req.context };
});

export const handler = resolver.getDefinitions();
