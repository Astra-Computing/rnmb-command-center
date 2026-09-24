# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Relationships

A Crew Member buys Stock. A Drink draws from Stock and charges its drinker at Cost, crediting whoever bought that Stock — that pairing is what every Balance is derived from. Drinks happen on a Night, which is either a Crew Night or a Host Night; only a Host Night has Guest Tabs. A Crew Member may leave the roster, and when they do, the Party they were survives under their Name Snapshot so their money still resolves.

## Crew and money

### Crew Member
Someone on the roster: a person who buys stock, drinks, and settles up with the others. Distinct from a guest, who never joins the roster and is tracked only through a Guest Tab.

A Crew Member can leave. Their money does not leave with them — the records they appear on keep a Name Snapshot, so they continue to resolve as a Party.

### Party
Whoever a money movement is attributed to: a Crew Member when their identity is still known, otherwise a Name Snapshot alone. Every Balance is computed over Parties, not over the roster, which is what lets someone who has left still be owed or owe.

Two Parties are the same Party only when they share an identity, or — lacking one — share a name exactly. A record that names nobody is not a Party and moves no money.

### Name Snapshot
The name copied onto a record at the moment it is written, stored beside the reference to the Crew Member rather than in place of it. It exists so that removing the person empties the reference without destroying the record or the money on it.

The snapshot is the authority once the reference is gone. Rules and constraints that must survive a departure are written against the snapshot, never against the identity.

### Balance
What one Party is owed or owes across everything recorded, derived on read rather than stored. Positive means owed, negative means owing, and all Balances together always sum to zero.

A Balance is never adjusted directly. It moves only as a consequence of a Drink being charged, a Guest Tab closing, or a Payment being recorded, and it is corrected by voiding the record that was wrong.

### Cost
What the liquor in a Drink actually cost, derived from the price paid for the Stock it came from. Crew drinks are charged at Cost with no markup; a guest is charged a Price instead.

### Price
What a guest pays for a Drink: its Cost plus the house markup, rounded to the configured step and fixed at the moment it is rung up. A later edit to Stock price or markup never moves a Price already charged.

### Payment
A record that one Party handed money to another, logged after the money actually moved. It moves both Balances toward zero and is never a prediction or an instruction.

A Payment logged in error is voided, never deleted, so the history it belonged to stays intact.

## Stock and drinks

### Stock
A specific thing bought and drunk from — an individual bottle, or a case counted in units — with the price paid for it and the Crew Member who paid. Distinct from the beverage type, which describes what it is; Stock is the physical item whose level depletes.

Stock is measured either as a volume or as a whole count of units, and that choice governs how it depletes and how it may be entered.

### Drink
One serving charged to somebody: either poured directly from Stock, or rung up from a Menu Item that may draw several Stock items at once. Either way it depletes Stock and moves Balances, and either way it is undone by voiding rather than deleting.

### Menu Item
A named drink defined as a recipe over beverage types, priced from what its ingredients currently cost. It is unavailable when Stock cannot cover it.

## Nights

### Night
A single occasion that Drinks are recorded against. Every Night is either a Crew Night or a Host Night, and the kind is fixed when it starts.

### Crew Night
A Night with no guests, where every Drink is charged at Cost to a Crew Member. It stays editable after it ends — a missed Drink can still be added and a wrong one voided — because nothing about it was ever counted as cash.

### Host Night
A Night with guests, where a bar register is open and guest Drinks go onto Guest Tabs. Ending one is final for its guest money: the Tabs were counted as cash when it closed. Crew Drinks rung up on the same Night stay correctable, because they sit on no Tab and were only ever charged at Cost.

### Guest Tab
A running total for one named guest across a Host Night, closed either as paid — naming the Crew Member who collected the money — or as written off, naming the Crew Member who absorbs what its Drinks cost. Either way the closing Crew Member is recorded by Name Snapshot, so the Tab outlives them.

## Quotebook

### Quotebook
The crew's own collection of things people have said, loaded from a text file into one browser. It is the only part of the dashboard that is deliberately not shared: it lives under its own storage key in the browser that loaded it, and never reaches the shared database, the dashboard's state or an exported archive. Each device loads its own copy; loading another replaces it.

### Quote
One line of the Quotebook, parsed into its text and the name it is attributed to — several names for an exchange, or *Unknown* for none. The name is matched to a Crew Member only to colour the Overview card, loosely and never for money; a Quote carries no Name Snapshot, so one from someone who has left simply takes the default colour.
