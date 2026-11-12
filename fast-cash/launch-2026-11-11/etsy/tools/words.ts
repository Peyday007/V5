/**
 * Christmas and winter word lists for the word-search products.
 *
 * Plain English words only: no song titles, no trademarked characters
 * (no Rudolph, Frosty or Grinch). The reindeer names come from the 1823 poem
 * "A Visit from St. Nicholas", which is in the public domain.
 */
export interface Theme {
  name: string;
  words: string[];
}

export const THEMES: Theme[] = [
  { name: 'Christmas Eve', words: ['STOCKING', 'CHIMNEY', 'MISTLETOE', 'ORNAMENT', 'GARLAND', 'TINSEL', 'WREATH', 'CANDLE', 'PRESENTS', 'RIBBON', 'SLEIGH', 'REINDEER', 'CAROLS', 'ANGEL', 'BELLS', 'HOLLY', 'FIREPLACE', 'NUTCRACKER', 'MIDNIGHT', 'COOKIES'] },
  { name: 'Winter Wonderland', words: ['SNOWFLAKE', 'SNOWMAN', 'ICICLE', 'BLIZZARD', 'MITTENS', 'SCARF', 'SLED', 'SKATES', 'FROST', 'CHILLY', 'IGLOO', 'SNOWBALL', 'FLURRY', 'EARMUFFS', 'BOOTS', 'SHOVEL', 'PINECONE', 'COCOA', 'FLANNEL', 'TOBOGGAN'] },
  { name: 'Holiday Baking', words: ['GINGERBREAD', 'COOKIES', 'SPRINKLES', 'FROSTING', 'CINNAMON', 'NUTMEG', 'FUDGE', 'CANDYCANE', 'SHORTBREAD', 'PEPPERMINT', 'MOLASSES', 'VANILLA', 'FRUITCAKE', 'EGGNOG', 'BUTTER', 'SUGAR', 'OVEN', 'ROLLINGPIN', 'APRON', 'WHISK'] },
  { name: "Santa's Workshop", words: ['SANTA', 'ELVES', 'TOYS', 'NORTHPOLE', 'WORKSHOP', 'NAUGHTY', 'NICE', 'SACK', 'HAMMER', 'WRAPPING', 'CLAUS', 'DASHER', 'DANCER', 'PRANCER', 'VIXEN', 'COMET', 'CUPID', 'DONNER', 'BLITZEN', 'WORKBENCH'] },
  { name: 'The Nativity', words: ['BETHLEHEM', 'MANGER', 'SHEPHERDS', 'WISEMEN', 'ANGELS', 'MARY', 'JOSEPH', 'STABLE', 'FRANKINCENSE', 'MYRRH', 'GOLD', 'CAMELS', 'DONKEY', 'LAMB', 'HALLELUJAH', 'GLORY', 'PEACE', 'NOEL', 'STARLIGHT', 'SAVIOR'] },
  { name: 'Deck the Halls', words: ['POINSETTIA', 'LIGHTS', 'TOPPER', 'BAUBLE', 'ADVENT', 'LANTERN', 'EVERGREEN', 'SPRUCE', 'BERRIES', 'VELVET', 'SILVER', 'GOLDEN', 'SPARKLE', 'GLITTER', 'MANTEL', 'BANISTER', 'TABLETOP', 'BOWS', 'TREE', 'WINDOW'] },
  { name: 'Gifts and Giving', words: ['PACKAGE', 'TAGS', 'TAPE', 'SCISSORS', 'SURPRISE', 'WISHLIST', 'GENEROUS', 'THANKFUL', 'KINDNESS', 'SHARING', 'GRATITUDE', 'CARDS', 'STAMPS', 'MAILBOX', 'DELIVERY', 'UNWRAP', 'GIVE', 'CHARITY', 'FAMILY', 'NEIGHBOR'] },
  { name: 'Cozy Christmas', words: ['BLANKET', 'SLIPPERS', 'PAJAMAS', 'FIRESIDE', 'MARSHMALLOW', 'CIDER', 'QUILT', 'SWEATER', 'MOVIE', 'POPCORN', 'STORYBOOK', 'CANDLELIGHT', 'HEARTH', 'KETTLE', 'TEAPOT', 'NAP', 'SNUGGLE', 'WARMTH', 'HOME', 'RECLINER'] },
  { name: 'Christmas Dinner', words: ['TURKEY', 'HAM', 'ROAST', 'GRAVY', 'STUFFING', 'CRANBERRY', 'POTATOES', 'CARROTS', 'BRUSSELS', 'ROLLS', 'CASSEROLE', 'PUDDING', 'TABLECLOTH', 'NAPKIN', 'PLATTER', 'FEAST', 'DESSERT', 'PIE', 'GRACE', 'LEFTOVERS'] },
  { name: 'Winter Birds and Woods', words: ['CARDINAL', 'CHICKADEE', 'BLUEJAY', 'OWL', 'ROBIN', 'SPARROW', 'FINCH', 'WOODPECKER', 'JUNCO', 'NUTHATCH', 'BIRCH', 'CEDAR', 'SNOWDRIFT', 'MOONLIGHT', 'DEER', 'FOX', 'RABBIT', 'BIRDFEEDER', 'SUET', 'TRACKS'] },
  { name: 'Caroling', words: ['CAROLERS', 'SING', 'HARMONY', 'CHOIR', 'MELODY', 'HYMN', 'LANTERN', 'DOORSTEP', 'NEIGHBORS', 'JINGLE', 'CHIME', 'VERSE', 'CHORUS', 'ALTO', 'SOPRANO', 'TENOR', 'BASS', 'ORGAN', 'PIANO', 'SONGBOOK'] },
  { name: 'Happy New Year', words: ['CONFETTI', 'MIDNIGHT', 'COUNTDOWN', 'RESOLUTION', 'FIREWORKS', 'PARTY', 'TOAST', 'CHEERS', 'JANUARY', 'CALENDAR', 'HATS', 'NOISEMAKER', 'DANCE', 'HOPE', 'STREAMERS', 'BALLOONS', 'CLOCK', 'TIMES', 'SQUARE', 'FRIENDS'] },
];

/** Shorter words for the children's pack (grid 11×11). */
export const KID_THEMES: Theme[] = [
  { name: 'Santa', words: ['SANTA', 'SLEIGH', 'ELF', 'TOYS', 'SACK', 'BOOTS', 'BEARD', 'CHIMNEY', 'COOKIES', 'MILK', 'LIST', 'NICE'] },
  { name: 'Snow Day', words: ['SNOW', 'SLED', 'HAT', 'MITTENS', 'SCARF', 'COCOA', 'ICE', 'COLD', 'SNOWMAN', 'IGLOO', 'BOOTS', 'COAT'] },
  { name: 'The Tree', words: ['TREE', 'STAR', 'LIGHTS', 'BOW', 'BELL', 'ANGEL', 'TINSEL', 'PINE', 'GIFT', 'RIBBON', 'CANDY', 'WREATH'] },
  { name: 'Reindeer', words: ['DASHER', 'DANCER', 'PRANCER', 'VIXEN', 'COMET', 'CUPID', 'DONNER', 'BLITZEN', 'ANTLERS', 'HOOVES', 'FLY', 'SKY'] },
  { name: 'Cookies', words: ['BAKE', 'OVEN', 'SUGAR', 'FLOUR', 'EGGS', 'BUTTER', 'ICING', 'SPRINKLE', 'GINGER', 'MIXER', 'TRAY', 'YUM'] },
  { name: 'Presents', words: ['GIFT', 'BOX', 'PAPER', 'TAPE', 'TAG', 'BOW', 'SHAKE', 'OPEN', 'SURPRISE', 'TOY', 'GAME', 'BOOK'] },
];
