# Mahjong Shadow Board

A personal Chrome extension for the Washington Post Mahjong game
(https://games.washingtonpost.com/games/mahjong, made by Arkadium).

It reads the board straight from the game's own state. That's more reliable
than watching the tiles fly in: it works with **New Game**, **Continue**,
shuffles, and it can't miss a tile.

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

- **Solver** (on by default): as soon as a board appears it searches every line of play
  (hidden tiles included). The verdict is in the panel header:
  - **✓ winnable**: the next pair to play glows **purple** on the real board, and the next
    5 pairs are numbered in the panel. Just play the purple pair each time. If you play
    something else (or shuffle), it re-plans from where you are.
  - **✗ not winnable**: proven. The purple pair is then the best move for points.
  - **? no win found yet**: it ran out of time (45s). The board may still be winnable;
    it re-checks after every move. Until then, purple is the best move for points.

  **Score planning:** once it knows the board is winnable, it spends up to 30 seconds
  looking for the highest-scoring way to win. The panel counts down and shows the best
  score found so far; click **use it now** to stop early and play that line. It plans
  whole same-suit streaks (each match in a streak multiplies, so long streaks while the
  board is still full are worth the most), and only takes a streak if a win is still
  guaranteed after it. It also runs a quicker move-by-move search and keeps whichever
  line scores higher.
  How high you can go depends mostly on the deal: some boards allow a long early streak
  and most don't.

  Every winning line is replayed against the game's own tile rules before it's shown.
  The game deals tiles at random, so some boards truly can't be won. In testing on
  60 random deals of this layout, about 87% were solved, most in under a second.
  Following only the purple pair cleared every board the solver called winnable.
  The **Solver on/off** button turns it off.

### How scoring works (read from the game code)

Each match scores **2 × suit value × tiles left on the board × streak**.

- **Suit values:** Characters 1, Dots 2, Bamboo 3, Winds 4, Dragons 5, Flowers 6, Seasons 7.
- **Streak:** goes up by one with each back-to-back match of the same *suit*, even if the tiles differ.

At game end you get 288 points for every pair removed (20,736 for a full clear); time left doesn't change it.

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
