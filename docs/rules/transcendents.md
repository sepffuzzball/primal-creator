# Transcendents

## Source & status

- Source: `https://the-primal-hunter.fandom.com/wiki/Transcendent`,
  `https://the-primal-hunter.fandom.com/wiki/Bloodlines`,
  `https://the-primal-hunter.fandom.com/wiki/Titles`.
- The **definition**, the **known examples**, and the **cost** are verified. The
  exact trigger/threshold is **wiki-uncertain**.

## Verified

- **A transcendent is a person possessing a transcendent skill.**
- A **transcendent skill** is, per the Malefic Viper, "essentially a self-created
  skill that breaks some fundamental rules [...] otherwise not allowed within the
  system's current parameters and limitations."
- Transcendent skills are **extremely rare**; "there are 'more gods than
  transcendents'." They are akin to bloodline abilities but differ:
  - A **Bloodline** is innate to the Truesoul (see `docs/rules/bloodlines.md`).
  - A **transcendence** is something "surrendered" to an individual by the system
    upon that person meeting some invisible threshold and gaining enlightenment.
- Being a Transcendent also leads to a mutation of the soul, but is **far less
  pervasive** than a bloodline, because a transcendent skill is born from who the
  person already is.
- **Cost:** transcendent power can come at a heavy cost. Example: the Sword
  Saint's transcendent skill costs him **Path levels** to use.

## Known transcendents (verified list)

| Transcendent | Transcendent skill | Note |
| --- | --- | --- |
| The Holy Mother | Holyland | Creates a realm to house souls of the blessed |
| Eversmile | Karmic Annihilation | Severs records / makes them cease to exist |
| Valdemar | Fighting Spirit | A golden aura that crushes others' auras |
| Yip of Yore | Usurper of Legends | Acquires titles of others by condensing records |
| The Malefic Viper | Malefic Alchemy: Transmutation | Turns anything into suitable material |
| Aeon Clok | (time-stop) | Received after reaching S-grade |

## Wiki-uncertain

- The exact **threshold** at which the system offers transcendence (described as
  "some invisible threshold").
- Whether transcendence is grade-gated (one example is received after S-grade, but
  no general rule is stated).

## Verified titles

The Titles page lists a "Transcendents, Bloodlines and Unique Lifeforms" category
that includes a **Transcendent** title.

## Engine note

Model a transcendent as a (boolean) quality plus a transcendent skill, both of
which exist "outside the system" and can carry a cost. Because the trigger is
unspecified, treat it as a configurable flag rather than a derived formula.
