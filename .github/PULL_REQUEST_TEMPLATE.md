## Summary

<!-- Brief description of what this PR does -->

## Type of Change

- [ ] Bug fix
- [ ] New feature / endpoint
- [ ] Security fix
- [ ] Refactor / cleanup
- [ ] Documentation

## Testing

- [ ] Unit tests pass (`npm test`)
- [ ] Tested against local Miniflare / `wrangler dev`
- [ ] Relevant new tests added

## Checklist

- [ ] No secrets committed
- [ ] Input validation (Zod) added for new endpoints
- [ ] Rate limiting applied where needed
- [ ] Error responses use standard `{ data: null, error: { code, message, status } }` shape
