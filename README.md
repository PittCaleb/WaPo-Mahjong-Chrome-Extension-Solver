# Mahjong Shadow Board

A personal Chrome extension for the Washington Post Mahjong game
(https://games.washingtonpost.com/games/mahjong, made by Arkadium).

It reads the board straight from the game's own state. That's more reliable
than watching the tiles fly in: it works with **New Game**, **Continue**,
shuffles and undo, and it can't miss a tile.

## What it shows

A floating, draggable **Shadow Board** panel with each of the 5 layers drawn
separately, so you can see tiles that are hidden under others.

- **Hatched tile + number badge**: hidden; the badge shows how many tiles are on top of it.
- **Dimmed tile**: blocked (left and right both occupied, or covered).
- **White inner edge**: free to play.
- **Dashed outline**: already removed.
- **Click a tile in the game** (or in the panel): its matches (1 or 3) glow green
  everywhere, hidden ones included. The line above the board lists each match's
  layer and whether it's FREE, blocked, or hidden under N tiles.
- **Red tile**: sits above its own twin, so you have to clear it early. Its buried twin
  gets a red dashed outline, and the list at the bottom names each one.
  This updates live as you play.
- **Tint real board** (optional): matching tiles turn green, and red-flagged tiles turn
  red, on the actual game board too.

- **Streak planner**: lists each suit you can match several times in a row right now,
  looking ahead at tiles each match frees up, with the points that streak would earn.
  Click a suit to number its tiles in play order (1, 2, 3…); the next pair also glows
  blue on the real board.

### How scoring works (read from the game code)

Each match scores **2 × suit value × tiles left on the board × streak**.

- **Suit values:** Characters 1, Dots 2, Bamboo 3, Winds 4, Dragons 5, Flowers 6, Seasons 7.
- **Streak:** goes up by one with each back-to-back match of the same *suit*, even if the tiles differ.

At game end you get 288 points for every pair removed; time left doesn't change it.
Undo doesn't take points away.

`−` / `+` resize the panel, `▁` minimizes it. You can drag it by the header, and it
remembers where you put it.

## Install (one time)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder: `~/projects/mahjong-shadow-board`.
4. Reload the Mahjong page.

After editing any file, click the ↻ reload icon on the extension card, then reload the page.

## How it works

- `frame.js` runs inside the Arkadium game iframe
  (`arenacloud.cdn.arkadiumhosted.com/.../game-rendering-iframe/`), in the page's
  JS world. It reads `window.__arenax_v1__.MahjongGame.game.game` (the Phaser game),
  then the current scene's `_board._tiles`. Each tile has `Layer`, `Col`, `Row`,
  `Suit`, `Value`, `Type`, `IsInBoard` and `IsBlocked`. It uses the game's own match rule:
  same suit, and either the same value or both flower/season type. It pulls tile
  artwork from the `gameobjects` atlas and posts a snapshot to the parent page
  5×/second when something changes.
- `top.js` / `top.css` draw the panel on games.washingtonpost.com.

It never makes moves or changes the game. All it does is read the board and, if you
turn on tinting, recolor tile sprites.

If Arkadium ships a new game build (currently `Release-40`), the internal
names (`_board`, `_tiles`, `_boardView`, `_tileModelToView`, `_backSprite`)
may change and the panel will say "waiting for a game…".
