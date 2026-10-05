# API documentation

Two things, kept apart on purpose:

| What                                                                                                       | Where                                                                    | Who it is for                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The contract** (every route, field and error code)                                                       | [openapi.yaml](openapi.yaml)                                             | Machines and exact questions. The frontend generates its TypeScript types from it (`npm run api:types` in the frontend repo), so a change that breaks the frontend fails its build. |
| **The features** (what each does, its endpoints, which frontend feature uses them, status, open decisions) | The backend tracker: <https://claude.ai/artifact/RzGP4ky7jbKQMoUVA2WFYw> | People. It follows the same phases as the frontend tracker (<https://claude.ai/artifact/Ck84aYSJZ4krz5jTD9Rpnk>), so the two can be read side by side.                              |

## When you add or change an endpoint

1. Write or change the contract in `openapi.yaml` first. Keep it to the contract: no feature stories, no status.
2. Write the tests, then the code.
3. Update the feature in the backend tracker: its description, its endpoints, who uses them, its status and a note.
4. Run `npm run api:types` in the frontend and fix anything the compiler now flags.
