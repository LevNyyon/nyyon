# Social identities

Who appears as the poster in each channel's preview. Edit the JSON block; it is
parsed live. `avatar_url` may be any image URL; when null the preview renders
initials.

```json
{
  "linkedin-company": { "name": "Your Company", "headline": "What you do, in six words", "avatar_url": null },
  "linkedin-personal": { "name": "Your Name", "headline": "Role · Your Company", "avatar_url": null }
}
```
