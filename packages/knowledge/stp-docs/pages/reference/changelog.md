---
id: changelog
title: Changelog
sidebar_position: 3
---

# Changelog

Release history for the `sketch-thru-plan-sdk` package.

## 0.6.13-alpha.0

- Added `sendSimulatedSpeechRecognition()` method to send typed text as simulated speech recognition
- Added `extensions` property to `StpItem`, `StpTaskOrg`, and `StpTaskOrgRelationship` for roundtripping custom client data through STP

## 0.6.12

- Updated package versions

## 0.6.11

- Added C2SIM task property: `rulesOfEngagement`
- Added parameter to toggle task confirmation from/to un/confirmed
- Added Task Org Unit property that contains the speech phrases generated from the `name`

## 0.6.10

- Added C2SIM configuration parameters: `includeMapGraphicId`, `entityNameCharLimit`, `rulesOfEngagement`

## 0.6.9

- Added C2SIM properties to symbols: DIS code, federate, resources

## 0.6.8

- Fixed issue that caused C2SIM Export operation error messages not to be received
- Added `importPlanData()` method that loads additional data into an existing scenario

## 0.6.7

- Added C2SIM generation options to proxy constructor

## 0.6.6

- Added C2SIM report event propagation
- Moved C2SIM methods to proxy object (prep for adding options)

## 0.6.5

- Added C2SIM interaction support

## 0.6.4

- Added `syncScenarioSession()` method that reconciles app content with a session context
- Returning session id on `connect()`

## 0.6.3

- Added optional `sessionId` parameter to `connect()`

## 0.6.2

- Added custom command events
- Removed redundant `poids` parameter from `onSymbolEdited` event (same as `location.candidatePoids`)

## 0.6.1

- Added support for TO import/export
- Fixed typedoc definitions

## 0.6.0

- Added support for role switching
- Added support for scenario management

## 0.5.1

- Added support for Task Orgs — Units and Relationships
- For symbols created from a Task Org/ORBAT, the unique id of the Task Org Unit is included as a `toUnitPoid` property

## 0.5.0

- Added support for Tasks
- Updated package versions to remove vulnerabilities

## 0.4.0

- Removed speech code from the SDK — speech must now be provided via the separate [`@hyssostech/azurespeech-plugin`](https://github.com/hyssostech/sketch-thru-plan-sdk-resources/tree/main/plugins/speech) or a compatible plugin

## 0.3.1

- Restricting the speech display to the client that produced it
- Added `asGeoJSON()` method to `StpSymbol`

## 0.3.0

- Added support for symbol update, deletion, N-best selection
- Strict mode compliance changes

## 0.2.0

- Switched from gulp to npm scripts
- Moved to rollup from browserify, added prettier
- Connector code refactoring and cleanup

## 0.1.5 – 0.1.3

- Documentation improvements
- Package and connector code cleanup

## 0.1.2

- Added typedoc documentation
- Hosting docs on GitHub Pages

## 0.1.1

- Refactored to isolate speech recognition into a plugin-based architecture
- Moved samples and quickstart to a separate resources project

## 0.1.0

- Initial release — sketch and speech collection, symbol recognition handling
