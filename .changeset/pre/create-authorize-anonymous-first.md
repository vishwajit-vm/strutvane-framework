---
"@strutvane/framework": patch
---

`POST /<resource>` answers an anonymous caller who may not create with a plain 401 before reading or validating the body, so validation issues no longer describe the model's fields to someone who may not use it. Authenticated callers are still validated first and then authorized with the input.
