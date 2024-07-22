/*global systemDictionary:true */
'use strict';

// eslint-disable-next-line no-unused-vars
systemDictionary = {
    'extron adapter settings': {
        'en': 'Adapter settings for extron',
        'de': 'Adaptereinstellungen für extron',
        'ru': 'Настройки адаптера для extron',
        'pt': 'Configurações do adaptador para extron',
        'nl': 'Adapterinstellingen voor extron',
        'fr': 'Paramètres d\'adaptateur pour extron',
        'it': 'Impostazioni dell\'adattatore per extron',
        'es': 'Ajustes del adaptador para extron',
        'pl': 'Ustawienia adaptera dla extron',
        'zh-cn': 'extron的适配器设置'
    },
    'select_device_type': {
        'en': 'select device type',
        'de': 'Gerätetyp auswählen',
        'ru': 'выберите тип устройства',
        'pt': 'selecione o tipo de dispositivo',
        'nl': 'selecteer het apparaattype',
        'fr': 'sélectionnez le type d\'appareil',
        'it': 'selezionare il tipo di dispositivo',
        'es': 'seleccione el tipo de dispositivo',
        'pl': 'wybierz typ urządzenia',
        'zh-cn': '选择设备类型'
    },
    'attention':  {
        'en': 'Attention! device type can only be selectet once. No change possible after selection. To change device type you have to delete the instance.',
        'de': 'Achtung! Gerätetyp kann nur einmal ausgewählt werden. Keine Änderung nach Auswahl möglich. Um den Gerätetyp zu ändern, müssen Sie die Instanz löschen.',
        'ru': 'Внимание! тип устройства можно выбрать только один раз. После выбора изменения невозможны. Чтобы изменить тип устройства, вы должны удалить экземпляр.',
        'pt': 'Atenção! o tipo de dispositivo só pode ser selecionado uma vez. Nenhuma mudança possível após a seleção. Para alterar o tipo de dispositivo, você deve excluir a instância.',
        'nl': 'Aandacht! apparaattype kan slechts één keer worden geselecteerd. Geen wijziging mogelijk na selectie. Om het apparaattype te wijzigen, moet u de instantie verwijderen.',
        'fr': 'Attention! le type d\'appareil ne peut être sélectionné qu\'une seule fois. Aucun changement possible après sélection. Pour changer le type d\'appareil, vous devez supprimer l\'instance.',
        'it': 'Attenzione! il tipo di dispositivo può essere selezionato solo una volta. Nessuna modifica possibile dopo la selezione. Per cambiare il tipo di dispositivo devi eliminare l\'istanza.',
        'es': '¡Atención! el tipo de dispositivo solo se puede seleccionar una vez. No es posible realizar cambios después de la selección. Para cambiar el tipo de dispositivo, debe eliminar la instancia.',
        'pl': 'Uwaga! typ urządzenia można wybrać tylko raz. Brak możliwości zmiany po dokonaniu wyboru. Aby zmienić typ urządzenia, musisz usunąć instancję.',
        'zh-cn': '注意！设备类型只能选择一次。选择后无法更改。要更改设备类型，您必须删除实例。'
    },
    'host':  {
        'en': 'ip address or FQDN',
        'de': 'IP-Adresse oder FQDN',
        'ru': 'IP-адрес или полное доменное имя',
        'pt': 'endereço ip ou FQDN',
        'nl': 'ip-adres of FQDN',
        'fr': 'adresse IP ou FQDN',
        'it': 'indirizzo IP o FQDN',
        'es': 'dirección IP o FQDN',
        'pl': 'adres IP lub FQDN',
        'zh-cn': 'IP地址或FQDN'
    },
    'type':  {
        'en': 'transport protocol',
        'de': 'Transportprotokoll',
        'ru': 'транспортный протокол',
        'pt': 'protocolo de transporte',
        'nl': 'transportprotocol',
        'fr': 'protocole de transport',
        'it': 'protocollo di trasporto',
        'es': 'protocolo de transporte',
        'pl': 'protokół transportowy',
        'zh-cn': '传输协议'
    },
    'pollDelay': {
        'en': 'time between cyclic status querys (in ms)',
        'de': 'Zeit zwischen zyklischen Statusabfragen (in ms)',
        'ru': 'время между циклическими запросами статуса (в мс)',
        'pt': 'tempo entre consultas de status cíclico (em ms)',
        'nl': 'tijd tussen cyclische statusvragen (in ms)',
        'fr': 'temps entre les requêtes d\'état cycliques (en ms)',
        'it': 'tempo tra le richieste di stato cicliche (in ms)',
        'es': 'tiempo entre consultas cíclicas de estado (en ms)',
        'pl': 'czas między cyklicznymi zapytaniami o status (w ms)',
        'zh-cn': '循环状态查询之间的时间（以毫秒为单位）'
    },
    'reconnectDelay': {
        'en': 'time to wait after a connection failure for reconnect (in ms)',
        'de': 'Wartezeit nach einem Verbindungsfehler für die erneute Verbindung (in ms)',
        'ru': 'время ожидания повторного подключения после сбоя подключения (в мс)',
        'pt': 'tempo de espera após uma falha de conexão para reconectar (em ms)',
        'nl': 'wachttijd na een verbindingsfout om opnieuw verbinding te maken (in ms)',
        'fr': 'temps d\'attente après un échec de connexion pour se reconnecter (en ms)',
        'it': 'tempo di attesa dopo un errore di connessione per la riconnessione (in ms)',
        'es': 'tiempo de espera después de una falla de conexión para reconectar (en ms)',
        'pl': 'czas oczekiwania po awarii połączenia na ponowne połączenie (w ms)',
        'zh-cn': '连接失败后重新连接的等待时间（以毫秒为单位）'
    },
    'answerTimeout':  {
        'en': 'maximum time to wait for a answer (in ms)',
        'de': 'maximale Wartezeit auf eine Antwort (in ms)',
        'ru': 'максимальное время ожидания ответа (в мс)',
        'pt': 'tempo máximo de espera por uma resposta (em ms)',
        'nl': 'maximale wachttijd op antwoord (in ms)',
        'fr': 'temps maximum d\'attente pour une réponse (en ms)',
        'it': 'tempo massimo di attesa per una risposta (in ms)',
        'es': 'tiempo máximo para esperar una respuesta (en ms)',
        'pl': 'maksymalny czas oczekiwania na odpowiedź (w ms)',
        'zh-cn': '等待答案的最长时间（毫秒）'
    },
    'inactivityTimeout': {
        'en': 'maximum time to wait for a correct answer. Otherwise the connection will be cut and reconnected (in ms)',
        'de': 'maximale Wartezeit auf eine korrekte Antwort. Andernfalls wird die Verbindung unterbrochen und erneut verbunden (in ms).',
        'ru': 'максимальное время ожидания правильного ответа. В противном случае соединение будет прервано и восстановлено (в мс)',
        'pt': 'tempo máximo de espera por uma resposta correta. Caso contrário, a conexão será cortada e reconectada (em ms)',
        'nl': 'maximale tijd om op een juist antwoord te wachten. Anders wordt de verbinding verbroken en opnieuw verbonden (in ms)',
        'fr': 'temps maximum pour attendre une réponse correcte. Sinon la connexion sera coupée et reconnectée (en ms)',
        'it': 'tempo massimo di attesa per una risposta corretta. Altrimenti la connessione verrà interrotta e ricollegata (in ms)',
        'es': 'tiempo máximo para esperar una respuesta correcta. De lo contrario, la conexión se cortará y volverá a conectarse (en ms)',
        'pl': 'maksymalny czas oczekiwania na poprawną odpowiedź. W przeciwnym razie połączenie zostanie przerwane i ponownie połączone (w ms)',
        'zh-cn': '等待正确答案的最长时间。否则，连接将被切断并重新连接（以毫秒为单位）'
    },
    'pushDeviceStatus' : {
        'en': 'select if current database states will be pushed to device on startup, otherwise database will be updated with current device states',
        'de': 'Auswahl, ob beim Anlauf die aktuellen Datenbankwerte in das Gerät geschrieben werden, andernfalls wird die Datenbank mit dem aktuellen Gerätestatus aktualisiert'
    },
    'user': {
        'en': 'user name',
        'de': 'Benutzername',
        'ru': 'имя пользователя',
        'pt': 'nome do usuário',
        'nl': 'gebruikersnaam',
        'fr': 'Nom d\'utilisateur',
        'it': 'nome utente',
        'es': 'nombre de usuario',
        'pl': 'Nazwa Użytkownika',
        'zh-cn': '用户名'
    },
    'password': {
        'en': 'password',
        'de': 'Passwort',
        'ru': 'пароль',
        'pt': 'senha',
        'nl': 'wachtwoord',
        'fr': 'mot de passe',
        'it': 'parola d\'ordine',
        'es': 'contraseña',
        'pl': 'hasło',
        'zh-cn': '密码'
    }
};