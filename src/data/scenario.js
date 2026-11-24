// 剧本一《渡口》：15×11，大河横贯 5/6 行之间，东西两桥；小河支流纵贯 col11/12 之间。
// 地形字符：P平原 R道路 F森林 H丘陵 T城镇（每行15字符，index=col）
export const scenario = {
  name: '渡口（1943·东线渡河攻坚）',
  width: 15,
  height: 11,
  turns: 12,
  objectivesNeeded: 2,
  objectives: [
    { col: 3, row: 5, name: '西桥出口' },
    { col: 10, row: 5, name: '东桥出口' },
    { col: 6, row: 1, name: '城镇' },
  ],
  terrain: [
    'PPPPPPPPPPPPPHH', // r0 守方纵深
    'PPPPPPTTPPPPFFP', // r1 城镇(6,1)(7,1)
    'PHHPPPRPRFFPFFP', // r2
    'PPPPTPRPPPRPFPP', // r3 村庄(4,3)
    'PPHRRPPPFRPPFPP', // r4
    'FFPRPPPPPPRPPFF', // r5 北岸河线
    'PPPRPPPFFPRPFFP', // r6 南岸河线
    'PPPRPPPPPPRFFPP', // r7
    'HHPRPPPPPPRPPPP', // r8
    'PPPRPPPPPPRPPPP', // r9
    'PPPRPPPPPPRPPPP', // r10 攻方入场
  ],
  // 大河：5/6 行之间的完整格边屏障（每列两条边）
  bigRiver: [
    ...Array.from({ length: 15 }, (_, c) => [[c, 5], [c, 6]]),
    ...Array.from({ length: 14 }, (_, c) => [[c, 5], [c + 1, 6]]),
  ],
  // 小河支流：col11/12 之间的连续格边链，从北缘一直到大河口（相邻边共享顶点，无缺口）
  smallRiver: [
    [[11, 0], [12, 0]], [[11, 1], [12, 0]], [[11, 1], [12, 1]], [[11, 1], [12, 2]],
    [[11, 2], [12, 2]], [[11, 3], [12, 2]], [[11, 3], [12, 3]], [[11, 3], [12, 4]],
    [[11, 4], [12, 4]], [[11, 5], [12, 4]], [[11, 5], [12, 5]],
  ],
  // 桥（大河格边子集）
  bridges: [[[3, 5], [3, 6]], [[10, 5], [10, 6]]],
  supplySource: {
    defender: Array.from({ length: 15 }, (_, c) => ({ col: c, row: 0 })),
    attacker: Array.from({ length: 15 }, (_, c) => ({ col: c, row: 10 })),
  },
  units: [
    // 守方：8步兵 2炮兵 2装甲
    { side: 'defender', type: 'infantry', col: 2, row: 4 },
    { side: 'defender', type: 'infantry', col: 3, row: 5 },
    { side: 'defender', type: 'infantry', col: 5, row: 5 },
    { side: 'defender', type: 'infantry', col: 7, row: 5 },
    { side: 'defender', type: 'infantry', col: 9, row: 5 },
    { side: 'defender', type: 'infantry', col: 10, row: 5 },
    { side: 'defender', type: 'infantry', col: 11, row: 3 },
    { side: 'defender', type: 'infantry', col: 11, row: 4 },
    { side: 'defender', type: 'artillery', col: 6, row: 1 },
    { side: 'defender', type: 'artillery', col: 10, row: 3 },
    { side: 'defender', type: 'armor', col: 4, row: 0 },
    { side: 'defender', type: 'armor', col: 9, row: 0 },
    // 攻方：6步兵 2炮兵 4装甲
    { side: 'attacker', type: 'armor', col: 3, row: 7 },
    { side: 'attacker', type: 'armor', col: 4, row: 7 },
    { side: 'attacker', type: 'armor', col: 9, row: 7 },
    { side: 'attacker', type: 'armor', col: 11, row: 7 },
    { side: 'attacker', type: 'infantry', col: 1, row: 9 },
    { side: 'attacker', type: 'infantry', col: 2, row: 9 },
    { side: 'attacker', type: 'infantry', col: 4, row: 10 },
    { side: 'attacker', type: 'infantry', col: 6, row: 9 },
    { side: 'attacker', type: 'infantry', col: 7, row: 10 },
    { side: 'attacker', type: 'infantry', col: 12, row: 9 },
    { side: 'attacker', type: 'artillery', col: 5, row: 8 },
    { side: 'attacker', type: 'artillery', col: 9, row: 8 },
  ],
};
