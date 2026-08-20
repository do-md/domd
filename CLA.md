# DoMD Contributor License Agreement (CLA)

> **Version 1.** This agreement is in force from the date it was added to the repository.
> It has not yet been reviewed by a lawyer and may be revised; a material revision will be
> published as a new version, and re-signature will be requested for it.

Thank you for your interest in contributing to DoMD.

## Why this agreement exists

DoMD is maintained by a single author and funded by **dual licensing**: the editor kernel
(`@do-md/core-react`) is available to everyone under the GPL-3.0, and separately available
under a commercial license to organizations that cannot comply with the GPL.

That model only works if the project maintainer holds the rights needed to offer *all* of
the code under both sets of terms. Code contributed under the GPL alone could never be
included in a commercial license — it would have to be removed and rewritten. This
agreement is what keeps that from happening.

Two things this agreement does **not** do:

- **You keep your copyright.** This is a license grant, not an assignment. You remain the
  owner of your contribution and may use, publish, and relicense it however you like,
  elsewhere, for any purpose.
- **It does not make the project less open.** Everything you contribute continues to be
  published under the project's open-source licenses (MIT for the application layer,
  GPL-3.0 for the kernel), for everyone, permanently.

## Scope

This agreement covers the whole `do-md/domd` repository, which contains two layers under
different licenses:

| Layer | Location | License |
| --- | --- | --- |
| Application (macOS app, web app, plugins, helper libraries) | repository root | MIT |
| Editor kernel (`@do-md/core-react`) | `.packages/@do-md/core/` | GPL-3.0-only, with §7 additional permissions |

One signature covers contributions to either layer.

---

## Agreement

You accept and agree to the following terms for your present and future Contributions
submitted to the Project. Except for the licenses granted here, You reserve all right,
title, and interest in and to Your Contributions.

### 1. Definitions

**"You"** (or **"Your"**) means the copyright owner, or the legal entity authorized by the
copyright owner, that is entering into this Agreement. For a legal entity, the entity
making a Contribution and all other entities that control, are controlled by, or are under
common control with that entity are considered a single Contributor.

**"Project"** means the DoMD project, hosted at `https://github.com/do-md/domd`.

**"Maintainer"** means Jayden Wang, the copyright holder of the Project.

**"Work"** means the work of authorship made available by the Maintainer as part of the
Project, to which Contributions are submitted.

**"Contribution"** means any original work of authorship, including any modifications or
additions to an existing work, that is intentionally submitted by You to the Maintainer for
inclusion in, or documentation of, the Project. "Submitted" means any form of electronic,
verbal, or written communication sent to the Maintainer or its representatives, including
but not limited to communication on electronic mailing lists, source code control systems,
and issue tracking systems that are managed by, or on behalf of, the Project — excluding
communication that is conspicuously marked or otherwise designated in writing by You as
"Not a Contribution."

### 2. Grant of copyright license

Subject to the terms and conditions of this Agreement, You hereby grant to the Maintainer
and to recipients of software distributed by the Maintainer a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare
derivative works of, publicly display, publicly perform, sublicense, and distribute Your
Contributions and such derivative works.

**2.1 Relicensing and dual licensing.** You further grant the Maintainer the right to
license Your Contributions, and derivative works of Your Contributions, under any license
terms of the Maintainer's choosing, including open-source licenses and proprietary or
commercial license terms, and to sublicense those rights through multiple tiers of
sublicensees. This right exists so that the Maintainer can continue to offer the Project
under both open-source and commercial terms.

**2.2 The Project stays open.** The Maintainer will continue to make Your Contributions
available under an OSI-approved open-source license as part of the Project. Nothing in
section 2.1 permits the Maintainer to withdraw any version of the Project that has already
been published under an open-source license. This commitment binds the Maintainer's
successors and assigns: whoever acquires the rights granted under this Agreement acquires
them subject to it.

**2.3 Moral rights.** To the fullest extent permitted by applicable law, You agree not to
assert against the Maintainer or recipients of the software any moral rights You may have
in Your Contributions, to the extent necessary to exercise the rights granted in this
section.

### 3. Grant of patent license

Subject to the terms and conditions of this Agreement, You hereby grant to the Maintainer
and to recipients of software distributed by the Maintainer a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this section)
patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer
the Work. This license applies only to those patent claims licensable by You that are
necessarily infringed by Your Contributions alone or by combination of Your Contributions
with the Work to which such Contributions were submitted.

If any entity institutes patent litigation against You or any other entity — including a
cross-claim or counterclaim in a lawsuit — alleging that Your Contribution, or the Work to
which You have contributed, constitutes direct or contributory patent infringement, then
any patent licenses granted to that entity under this Agreement for that Contribution or
Work terminate as of the date such litigation is filed.

### 4. Your representations

You represent that:

1. You are legally entitled to grant the above licenses.
2. Each of Your Contributions is Your original creation.
3. If Your employer has rights to intellectual property that You create, You have received
   permission to make Contributions on behalf of that employer, that Your employer has
   waived such rights for Your Contributions to the Project, or that Your employer has
   executed a separate corporate agreement with the Maintainer.
4. Your Contribution does not, to Your knowledge, violate any third party's copyrights,
   trademarks, patents, or other intellectual property rights.

### 5. Third-party work

Should You wish to submit work that is not Your original creation, You may submit it
separately from any Contribution, identifying the complete details of its source and of any
license or other restriction of which You are personally aware, and conspicuously marking
the work as "Submitted on behalf of a third-party: [named here]".

### 6. No obligation and no warranty

You are not expected to provide support for Your Contributions, except to the extent You
desire to provide support. You may provide support for free, for a fee, or not at all.
Unless required by applicable law or agreed to in writing, You provide Your Contributions
on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied, including, without limitation, any warranties or conditions of TITLE,
NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A PARTICULAR PURPOSE.

### 7. Notification

You agree to notify the Maintainer of any facts or circumstances of which You become aware
that would make these representations inaccurate in any respect.

---

## How to sign

You do not need to send anything by email. When you open a pull request, an automated check
will ask you to sign by leaving a comment on the pull request with exactly this text:

```txt
I have read the CLA Document and I hereby sign the CLA
```

Your signature — GitHub username, timestamp, and the pull request it was given on — is
recorded in this repository. One signature covers all of your future contributions.

Contributions made on behalf of a company may require a separate corporate agreement; open
an issue or contact the maintainer if that applies to you.
