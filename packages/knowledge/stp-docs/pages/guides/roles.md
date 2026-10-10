---
id: roles
title: Roles
sidebar_position: 4
---

# Roles

STP supports multiple planning roles: **S2** (Intel), **S3** (Operations), **S4** (Logistics), **Eng** (Engineering), and **FSO** (Fire Support Officer). Selecting a role causes the following effects:

- A **TO/ORBAT** matching the role's default affiliation (`hostile` for S2, `friend` for the rest) is activated, if available
- Symbols created under the role are **tagged** with the `creatorRole` property
- Recognition may be **biased** toward role-related language

## Switching Roles

Use `setCurrentRole()` to change the active role:

```javascript
await stpsdk.setCurrentRole('S3');
```

Role switching triggers language model loading for the associated TO/ORBAT, which may take some time. Use the optional `timeout` parameter to control cancellation (default: 30s):

```javascript
await stpsdk.setCurrentRole('S2', 60); // 60 second timeout
```

:::tip Robust UI pattern
Undo any visual selection (e.g., uncheck a radio button) immediately after sending the switch command, then re-apply the visual indicator only in the `onRoleSwitched` callback. This prevents your UI from being out of sync with STP if the switch fails.
:::

## Handling Role Switch Events

```javascript
stpsdk.onRoleSwitched = (role) => {
    if (role) {
        console.log("Role switched to:", role);
    } else {
        console.log("Role was reset");
        // No role is active
    }
};
```

When the role is reset (e.g., no matching context), the `role` parameter is `null`.

## StpRole Enum

```typescript
export enum StpRole {
    s2 = 'S2',
    s3 = 'S3',
    s4 = 'S4',
    fso = 'FSO',
    eng = 'ENG',
}
```

## Effect on Task Orgs

Role switching automatically selects the TO that matches the role's default affiliation:

| Role | Default Affiliation | Active TO |
|------|--------------------| ----------|
| S2 | Hostile | Hostile TO (if loaded) |
| S3 | Friend | Friendly TO (if loaded) |
| S4 | Friend | Friendly TO (if loaded) |
| FSO | Friend | Friendly TO (if loaded) |
| Eng | Friend | Friendly TO (if loaded) |

If no TO matching the affiliation has been loaded, the TO language is cleared. See [Task Org / ORBAT](./task-org) for full details on activation rules.

---

:::info Source & Samples
Full roles sample: [sketch-thru-plan-sdk-js/samples/roles](https://github.com/hyssostech/sketch-thru-plan-sdk-js/tree/main/samples/roles)
:::
