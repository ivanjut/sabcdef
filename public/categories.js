// The pool of daily categories. One is selected per day, deterministically,
// so every visitor sees the same category on the same date (see getToday() in
// app.js).
//
// Each item has a stable `id` (used as the key when saving tier placements)
// and an `emoji` used as its visual. Keeping items emoji-based means there's no
// image hosting to deal with — swap `emoji` for an `img` URL later without
// touching the tier logic.

export const CATEGORIES = [
  {
    name: "Desserts",
    blurb: "The sweet finale. Rank them before dinner regrets set in.",
    items: [
      { id: "tiramisu", name: "Tiramisu", emoji: "🍰" },
      { id: "icecream", name: "Ice Cream", emoji: "🍨" },
      { id: "donut", name: "Donut", emoji: "🍩" },
      { id: "cookie", name: "Cookie", emoji: "🍪" },
      { id: "cheesecake", name: "Cheesecake", emoji: "🧀" },
      { id: "brownie", name: "Brownie", emoji: "🍫" },
      { id: "pie", name: "Apple Pie", emoji: "🥧" },
      { id: "cupcake", name: "Cupcake", emoji: "🧁" },
      { id: "pudding", name: "Pudding", emoji: "🍮" },
      { id: "mochi", name: "Mochi", emoji: "🍡" },
      { id: "gelato", name: "Gelato", emoji: "🍦" },
      { id: "macaron", name: "Macaron", emoji: "🌈" }
    ]
  },
  {
    name: "Pizza Toppings",
    blurb: "Settle the pineapple debate once and for all.",
    items: [
      { id: "pepperoni", name: "Pepperoni", emoji: "🍕" },
      { id: "mushroom", name: "Mushroom", emoji: "🍄" },
      { id: "pineapple", name: "Pineapple", emoji: "🍍" },
      { id: "bacon", name: "Bacon", emoji: "🥓" },
      { id: "olives", name: "Olives", emoji: "🫒" },
      { id: "peppers", name: "Bell Peppers", emoji: "🫑" },
      { id: "onion", name: "Onion", emoji: "🧅" },
      { id: "sausage", name: "Sausage", emoji: "🌭" },
      { id: "basil", name: "Fresh Basil", emoji: "🌿" },
      { id: "anchovy", name: "Anchovy", emoji: "🐟" },
      { id: "chicken", name: "Chicken", emoji: "🍗" },
      { id: "extracheese", name: "Extra Cheese", emoji: "🧀" }
    ]
  },
  {
    name: "Fast Food Chains",
    blurb: "Drive-thru royalty vs. drive-thru regret.",
    items: [
      { id: "burger", name: "Burgers", emoji: "🍔" },
      { id: "fries", name: "Fries", emoji: "🍟" },
      { id: "taco", name: "Tacos", emoji: "🌮" },
      { id: "friedchicken", name: "Fried Chicken", emoji: "🍗" },
      { id: "sub", name: "Subs", emoji: "🥪" },
      { id: "nuggets", name: "Nuggets", emoji: "🍗" },
      { id: "shake", name: "Milkshake", emoji: "🥤" },
      { id: "hotdog", name: "Hot Dog", emoji: "🌭" },
      { id: "burrito", name: "Burrito", emoji: "🌯" },
      { id: "pizzaslice", name: "Pizza Slice", emoji: "🍕" }
    ]
  },
  {
    name: "Video Game Genres",
    blurb: "What you actually play vs. what you pretend to play.",
    items: [
      { id: "fps", name: "Shooters", emoji: "🔫" },
      { id: "rpg", name: "RPGs", emoji: "🗡️" },
      { id: "platformer", name: "Platformers", emoji: "🍄" },
      { id: "racing", name: "Racing", emoji: "🏎️" },
      { id: "fighting", name: "Fighting", emoji: "🥊" },
      { id: "strategy", name: "Strategy", emoji: "♟️" },
      { id: "horror", name: "Horror", emoji: "👻" },
      { id: "puzzle", name: "Puzzle", emoji: "🧩" },
      { id: "sports", name: "Sports", emoji: "⚽" },
      { id: "sandbox", name: "Sandbox", emoji: "🧱" },
      { id: "roguelike", name: "Roguelike", emoji: "💀" },
      { id: "rhythm", name: "Rhythm", emoji: "🎵" }
    ]
  },
  {
    name: "Hot Drinks",
    blurb: "The mug that gets you through the morning.",
    items: [
      { id: "espresso", name: "Espresso", emoji: "☕" },
      { id: "latte", name: "Latte", emoji: "🥛" },
      { id: "greentea", name: "Green Tea", emoji: "🍵" },
      { id: "cocoa", name: "Hot Cocoa", emoji: "🍫" },
      { id: "chai", name: "Chai", emoji: "🫖" },
      { id: "cappuccino", name: "Cappuccino", emoji: "☕" },
      { id: "blacktea", name: "Black Tea", emoji: "🍂" },
      { id: "mocha", name: "Mocha", emoji: "🤎" },
      { id: "cider", name: "Hot Cider", emoji: "🍎" },
      { id: "matcha", name: "Matcha", emoji: "🍵" }
    ]
  },
  {
    name: "Weekend Activities",
    blurb: "How the days off actually get spent.",
    items: [
      { id: "hiking", name: "Hiking", emoji: "🥾" },
      { id: "gaming", name: "Gaming", emoji: "🎮" },
      { id: "brunch", name: "Brunch", emoji: "🥞" },
      { id: "movies", name: "Movie Night", emoji: "🎬" },
      { id: "napping", name: "Napping", emoji: "😴" },
      { id: "shopping", name: "Shopping", emoji: "🛍️" },
      { id: "reading", name: "Reading", emoji: "📚" },
      { id: "gym", name: "The Gym", emoji: "🏋️" },
      { id: "cooking", name: "Cooking", emoji: "🍳" },
      { id: "beach", name: "Beach Day", emoji: "🏖️" },
      { id: "concert", name: "Live Music", emoji: "🎤" },
      { id: "cleaning", name: "Cleaning", emoji: "🧹" }
    ]
  },
  {
    name: "Pets",
    blurb: "Companions ranked. No, your one doesn't automatically get S.",
    items: [
      { id: "dog", name: "Dog", emoji: "🐕" },
      { id: "cat", name: "Cat", emoji: "🐈" },
      { id: "rabbit", name: "Rabbit", emoji: "🐇" },
      { id: "hamster", name: "Hamster", emoji: "🐹" },
      { id: "fish", name: "Fish", emoji: "🐠" },
      { id: "parrot", name: "Parrot", emoji: "🦜" },
      { id: "snake", name: "Snake", emoji: "🐍" },
      { id: "turtle", name: "Turtle", emoji: "🐢" },
      { id: "lizard", name: "Lizard", emoji: "🦎" },
      { id: "ferret", name: "Ferret", emoji: "🦦" }
    ]
  }
];
