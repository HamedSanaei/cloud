# Project Instructions

- After every completed code or design change, include exactly one suggested Conventional Commit message in the final response.
- Format the suggestion as `Suggested commit: <type>(<scope>): <summary>`.
- Do not create the commit unless the user explicitly asks for it.

- ParsGreen notification samples and approval statuses: docs/PARSGREEN_TEMPLATES.md and backend/src/modules/auth/parsgreen-templates.ts. Never treat approved example text as approval for dynamic WhiteText substitution; never send rejected/unknown templates.
- Registration: mobile+OTP is default; email+OTP is optional. SMS login must only use verified phone numbers and must honor TOTP.
