/**
 * Español (España + Latinoamérica). Vocabulario neutro para ambos
 * mercados. Términos de gaming en inglés cuando la comunidad los usa
 * (ranking, epic, gems) — más natural para jugadores hispanohablantes.
 */
export const ES: Record<string, string> = {
    // ---------- Menú principal ----------
    'menu.title':        'Tetri Tower',
    'menu.subtitle':     'To the Heavens',
    'menu.endless':      'Infinito',
    'menu.levels':       'Niveles',
    'menu.blind':        'Ciego',
    'menu.leaderboard':  'Clasificación',
    'menu.reset':        'Reiniciar',
    'menu.levelSelect':  'Seleccionar Nivel',
    'menu.back':         '← Atrás',

    // ---------- Carga ----------
    'loading.text':      'Cargando',

    // ---------- HUD ----------
    'hud.back':          '← Inicio',
    'hud.height':        'Altura',
    'hud.heightValue':   'Altura  {n}',
    'hud.next':          'NEXT',

    // ---------- Picker de ítems ----------
    'picker.title':      '⚡ Elige 1 objeto mágico',
    'picker.hint':       'Toca para confirmar · Color = Rareza',
    'picker.refresh':    '🔄 Rerroll gratis',
    'picker.adRefresh':  '🎬 Ver anuncio y rerrollear',
    'rarity.common':     'Común',
    'rarity.uncommon':   'Poco común',
    'rarity.rare':       'Raro',
    'rarity.epic':       'Épico',

    // ---------- Nombres de ítems ----------
    'item.hourglass1':    'Reloj 1 min',
    'item.hourglass2':    'Reloj 2 min',
    'item.hourglass3':    'Reloj 3 min',
    'item.excavator1':    'Excavador ×1',
    'item.excavator2':    'Excavador ×2',
    'item.excavator3':    'Excavador ×3',
    'item.excavatorTop1': 'Barredor superior ×1',
    'item.excavatorTop2': 'Barredor superior ×2',
    'item.excavatorTop3': 'Barredor superior ×3',
    'item.shapeshifter':  'Cambia-forma',
    'item.rewind':        'Rebobinar',
    'item.meteor1':       'Meteoros ×5',
    'item.meteor2':       'Meteoros ×10',
    'item.meteor3':       'Meteoros ×15',
    'item.rocket1':       'Cohetes ×8',
    'item.rocket2':       'Cohetes ×16',
    'item.rocket3':       'Cohetes ×24',
    'item.gatling1':      'Gatling ×4',
    'item.gatling2':      'Gatling ×8',
    'item.gatling3':      'Gatling ×12',
    'item.mortar5':       'Mortero ×5',
    'item.mortar10':      'Mortero ×10',
    'item.mortar15':      'Mortero ×15',

    // ---------- Descripciones ----------
    'desc.hourglass1':    'Caída lenta por 1 minuto',
    'desc.hourglass2':    'Caída lenta por 2 minutos',
    'desc.hourglass3':    'Caída lenta por 3 minutos',
    'desc.excavator1':    'Elimina 1 fila coloreada del fondo',
    'desc.excavator2':    'Elimina 2 filas coloreadas del fondo',
    'desc.excavator3':    'Elimina 3 filas coloreadas del fondo',
    'desc.excavatorTop1': 'Elimina 1 fila coloreada del tope',
    'desc.excavatorTop2': 'Elimina 2 filas coloreadas del tope',
    'desc.excavatorTop3': 'Elimina 3 filas coloreadas del tope',
    'desc.shapeshifter':  'Elige la forma de la siguiente pieza',
    'desc.rewind':        'Retrocede 3 movimientos',
    'desc.meteor1':       '5 cubos pequeños caen rápidamente',
    'desc.meteor2':       '10 cubos pequeños caen rápidamente',
    'desc.meteor3':       '15 cubos pequeños caen rápidamente',
    'desc.rocket1':       '8 cohetes perforan la cima',
    'desc.rocket2':       '16 cohetes perforan la cima',
    'desc.rocket3':       '24 cohetes perforan la cima',
    'desc.gatling1':      '4 balas barren desde el centro',
    'desc.gatling2':      '8 balas barren desde el centro',
    'desc.gatling3':      '12 balas barren desde el centro',
    'desc.mortar5':       '5 gotas rellenan huecos flotantes',
    'desc.mortar10':      '10 gotas rellenan huecos flotantes',
    'desc.mortar15':      '15 gotas rellenan huecos flotantes',

    // ---------- Cambia-forma ----------
    'shapeshifter.title':    '🎲 Cambia-forma',
    'shapeshifter.subtitle': 'Elige una forma para la pieza actual',
    'shapeshifter.cancel':   'Cancelar',

    // ---------- Fate piece ----------
    'fate.modalTitle':   'Pieza del Destino',
    'fate.reroll':       'Rerroll del Destino',
    'fate.start':        'Comenzar',
    'fate.cellCount':    '{n} celdas',
    'fate.endlessSub':   'Infinito',
    'fate.levelSub':     'Nivel {n}',
    'fate.endlessMid':   'Infinito · Capa {layer}',
    'fate.subtitle':     '{tag} · {n} celdas',
    'fate.hint':         'Rerroll: ver anuncio para cambiar la pieza',

    // ---------- Collect mode ----------
    'collect.header':    'Objetivos de colección',

    // ---------- Level select ----------
    'level.name':        'Nivel {n}',
    'level.enter':       'Entrar al nivel',

    // ---------- Blind mode ----------
    'blind.fail.prompt': 'Desafío fallido. Toca para continuar.',
    'blind.showTower':   '🙉 Mostrar torre',
    'blind.hideTower':   '🙈 Ocultar torre',

    // ---------- Endless milestone ----------
    'endless.milestone': '¡Nivel {n} alcanzado!',

    // ---------- Pausa ----------
    'pause.title':       '⏸ Pausado',
    'pause.hint':        'Toca Continuar para volver',
    'pause.continue':    '▶ Continuar',
    'pause.home':        '< Inicio',

    // ---------- DEV ----------
    'debug.forceWin':    'Ganar',

    // ---------- Tutorial ----------
    'tutorial.hint.tap':          'Toca para cambiar la forma',
    'tutorial.hint.swipeRelease': 'Desliza horizontal y suelta para rotar',
    'tutorial.hint.swipeHold':    'Desliza y mantén para rotar continuo',
    'tutorial.hint.swipeDown':    'Desliza abajo para caer directo',
    'tutorial.skip':              'Omitir',

    // ---------- Login ----------
    'login.title':          'Bienvenido a Tetri Tower',
    'login.subtitle':       'Elige cómo empezar',
    'login.namePlaceholder':'Nombre (opcional)',
    'login.guestButton':    'Continuar como Invitado',
    'login.emailButton':    'Iniciar con Email',
    'login.googleButton':   'Iniciar con Google',
    'login.appleButton':    'Iniciar con Apple',
    'login.comingSoon':     '(Próximamente)',
    'login.orDivider':      'o',

    // ---------- Top-up ----------
    'menu.topup':           'Recargar',
    'topup.title':          'Comprar Gemas',
    'topup.balance':        'Gemas: {n}',
    'topup.gems':           '{n} Gemas',
    'topup.price':          '{price}',
    'topup.buyButton':      'Comprar',
    'topup.close':          'Cerrar',
    'topup.successTitle':   'Compra exitosa',
    'topup.successBody':    '{n} gemas obtenidas',
    'topup.failTitle':      'Compra fallida',
    'topup.failBody':       '{reason}',
    'topup.processing':     'Procesando...',
    'topup.mockNotice':     '(Modo prueba — sin cargo real)',

    // ---------- Leaderboard ----------
    'leaderboard.title':       'Clasificación',
    'leaderboard.back':        '↩ Atrás',
    'leaderboard.tab.level':   'Niveles',
    'leaderboard.tab.endless': 'Infinito',
    'leaderboard.tab.blind':   'Ciego',
    'leaderboard.you':         'Tú',
    'leaderboard.empty':       'Sin datos',
    'leaderboard.mockName':    'Jugador {n}',

    // ---------- Resultado ----------
    'result.gameOver':   'Fin del juego',
    'result.levelFail':  'Nivel fallido',
    'result.fail.hole':  'Hueco sellado',
    'result.fail.tall':  'Torre demasiado alta',
    'result.win':        '¡Completado! ✓',
    'result.retry':      'Reintentar',
    'result.endlessRetry': 'Jugar de nuevo',
    'result.nextLevel':  'Siguiente nivel',
    'result.replay':     'Repetir',
    'result.levelSelect':'Niveles',
    'result.home':       'Inicio',

    // ---------- Toggle idioma ----------
    'lang.toggle':       'Español',

    // ---------- Settings ----------
    'settings.button':       '⚙ Ajustes',
    'settings.title':        'Ajustes',
    'settings.lang':         'Idioma',
    'settings.gesture':      'Gestos',
    'settings.gesture.both': 'Flick + Arrastrar',
    'settings.gesture.drag': 'Solo arrastrar',
    'settings.keys':         'Botones virtuales',
    'settings.keys.on':      'On',
    'settings.keys.off':     'Off',
    'settings.bgm':          'Música',
    'settings.sfx':          'Efectos',
    'settings.close':        'Cerrar',
    'audio.off':             'Off',
    'audio.percent':         '{n}%',
    'settings.account.guest':  'Invitado',
    'settings.account.google': 'Google',
    'settings.account.apple':  'Apple',
    'settings.account.email':  'Email',
    'settings.account.copied':      'Copiado al portapapeles',
    'settings.account.copyFailed':  'Copia fallida',
    'settings.nickname.tooLong':     'El nombre máximo es {n} caracteres',
    'settings.nickname.title':       'Cambiar nombre',
    'settings.nickname.placeholder': 'Nuevo nombre',

    'common.confirm':    'Confirmar',
    'common.cancel':     'Cancelar',

    // ---------- Eliminar cuenta (App Store 5.1.1(v) requerido) ----------
    'settings.deleteAccount':         'Eliminar cuenta',
    'settings.deleteAccount.title':   '¿Eliminar cuenta?',
    'settings.deleteAccount.desc':    'Esta acción no se puede deshacer. Todos los datos (gemas, progreso, cuentas vinculadas) se borrarán permanentemente.',
    'settings.deleteAccount.pending': 'Eliminando...',
    'settings.deleteAccount.failed':  'Fallo, intenta de nuevo',

    'settings.tos':     'Términos de servicio',
    'settings.privacy': 'Política de privacidad',
    'gems.insufficient': 'Gemas insuficientes\nNecesitas {need}, tienes {have}',
    'gems.goTopUp':      'Recargar',
    'gems.cancel':       'Cancelar',
};
