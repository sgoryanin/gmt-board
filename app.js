(() => {
  'use strict';

  // Configuration and original-format demo responses.
  const CONFIG = Object.freeze({ slotStepMinutes: 15, minGapMinutes: 30, mockWsIntervalMs: 10000, mockWsMaxMessages: 100, mockHttpDelayMs: 260, workingWeekdays: Object.freeze([1, 2, 3, 4, 5]) });
  const DEPARTMENTS = [
    { id: 'medical', name: 'Медицинское оборудование', is_current: true, permitted: true },
    { id: 'laboratory', name: 'Лабораторное оборудование', is_current: false, permitted: true },
    { id: 'regional', name: 'Региональная служба · просмотр', is_current: false, permitted: false },
  ];
  const NAMES = ['Алексей Смирнов', 'Михаил Волков', 'Елена Кузнецова', 'Дмитрий Соколов', 'Андрей Морозов', 'Ирина Лебедева', 'Сергей Козлов', 'Анна Новикова', 'Павел Орлов', 'Олег Макаров', 'Виктор Зайцев', 'Мария Белова'];
  const MODELS = ['SLE 5000', 'Evita Infinity V500', 'PHS-800', 'WATO EX-65', 'SV 300', 'SLE 6000', 'Aplio i800', 'BeneVision N17'];
  const WORK_TYPES = ['ТО', 'Ремонт', 'Диагностика', 'Демонтаж', 'Ввод в эксплуатацию', 'Доп. диагностика', 'Доп. Ремонт'];
  const MANUAL_TYPES = Object.freeze(['Событие', 'Совещание', 'Отгул', 'Обучение']);
  const STATUS = Object.freeze({ open: 'Открыта', planned: 'Запланирована', in_progress: 'В работе', deferred: 'Отложена', completed: 'Выполнена' });
  const CLIENTS = ['Городская клиническая больница № 15', 'Поликлиника № 68 · филиал № 2', 'Диагностический центр «Северный»', 'Клиническая больница № 29', 'Медицинский центр «Здоровье»'];
  const $ = (id) => document.getElementById(id);
  const requestedNow = new URLSearchParams(location.search).get('mockNow');
  const demoNow = parseDemoNow(requestedNow);
  const state = { date: localDate(now()), departmentId: 'medical', data: null, query: '', sort: 'priority', requestId: 0, loading: true };
  let failNextLoad = new URLSearchParams(location.search).get('mockError') === 'once';
  let failNextCreate = new URLSearchParams(location.search).get('mockCreateError') === 'once';
  const requestedCreateDelay = Number(new URLSearchParams(location.search).get('mockCreateDelay'));
  const createDelayMs = Number.isFinite(requestedCreateDelay) && requestedCreateDelay >= 260 && requestedCreateDelay <= 5000 ? requestedCreateDelay : CONFIG.mockHttpDelayMs;
  let tomorrowTransfer = null;
  let failNextTomorrow = new URLSearchParams(location.search).get('mockTomorrowError') === 'once';
  const requestedTomorrowDelay = Number(new URLSearchParams(location.search).get('mockTomorrowDelay'));
  const tomorrowDelayMs = Number.isFinite(requestedTomorrowDelay) && requestedTomorrowDelay >= 260 && requestedTomorrowDelay <= 5000 ? requestedTomorrowDelay : CONFIG.mockHttpDelayMs;
  let creation = null;
  let creationReturnFocus = null;
  let returnFocus = null;
  let activeTaskId = null;
  const contexts = new Map();
  const STORAGE_KEY = 'gmt-board.demo.v1';
  const storageMode = new URLSearchParams(location.search).get('mockStorage');
  // Fault injection uses isolated memory and never reads or writes browser storage.
  let mockStored = storageMode === 'corrupt' ? '{broken' : null;
  const storage = {
    read() {
      if (storageMode === 'unavailable') throw new Error('Storage unavailable');
      return storageMode ? mockStored : localStorage.getItem(STORAGE_KEY);
    },
    write(value) {
      if (['unavailable', 'write-error'].includes(storageMode)) throw new Error('Storage unavailable');
      if (storageMode) mockStored = value; else localStorage.setItem(STORAGE_KEY, value);
    },
    remove() {
      if (storageMode === 'unavailable') throw new Error('Storage unavailable');
      if (storageMode) mockStored = null; else localStorage.removeItem(STORAGE_KEY);
    },
  };
  let invalidFixturePending = storageMode === 'memory' && new URLSearchParams(location.search).get('mockData') === 'invalid-text';
  let storageBlocked = false;
  let storageNotice = '';
  let wsSettings = { intervalMs: CONFIG.mockWsIntervalMs, maxMessages: CONFIG.mockWsMaxMessages, paused: false, generated: 0 };
  let wsTimer = null;
  let wsTimerVersion = 0;
  let wsResetVersion = 0;
  let wsReceipts = new Set();
  let queueRefreshPending = false;
  let wsNotice = '';
  let injectOnDrag = storageMode === 'memory' && new URLSearchParams(location.search).get('mockWsOnDrag') === 'once';

  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // One clock supplies status rules and history. The optional demo override is visibly labelled.
  function parseDemoNow(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && localDate(parsed) === value.slice(0, 10) && clock(parsed.getHours() * 60 + parsed.getMinutes()) === value.slice(11) ? parsed : null;
  }
  function now() { return demoNow ? new Date(demoNow) : new Date(); }
  function minuteNow() { const value = now(); value.setSeconds(0, 0); return value; }
  function scheduledAt(task, minutes) { return new Date(`${task.date}T${clock(minutes)}:00`); }
  function occupiedDuration(task) { return task.assignment ? task.assignment.end - task.assignment.begin : task.source.duration; }
  function originalPlan(task) { return task.plannedAssignment || task.assignment; }
  function timeNotice(task) {
    if (!task.assignment || task.status === 'completed') return '';
    const plan = originalPlan(task);
    if (now() > scheduledAt(task, plan.end)) return 'Просрочена';
    if (task.status === 'planned' && now() >= scheduledAt(task, plan.begin)) return 'Время начала наступило';
    return '';
  }
  function formatFact(value) { return new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }

  function parseDate(value, constrainSelection = true) {
    const date = typeof value === 'string' ? value.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Некорректная дата расписания.');
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(2000, 0, 1, 12);
    parsed.setFullYear(year, month - 1, day);
    if (year < 1 || localDate(parsed) !== date) throw new Error('Указана недействительная календарная дата.');
    if (constrainSelection && (year < 2000 || year > 2099)) throw new Error('Дата расписания должна находиться между 2000 и 2099 годами.');
    return date;
  }

  function dateObject(date) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year, month - 1, day, 12);
  }

  function addDays(date, days) {
    const result = dateObject(date);
    result.setDate(result.getDate() + days);
    return localDate(result);
  }

  function clock(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  function parseTime(value, date) {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):00$/.exec(value);
    if (!match || (match[1] !== '0001-01-01' && match[1] !== date) || Number(match[2]) > 23 || Number(match[3]) > 59) {
      throw new Error('Некорректное время события или рабочего дня.');
    }
    return Number(match[2]) * 60 + Number(match[3]);
  }

  function timeValue(minutes) { return `0001-01-01T${clock(minutes)}:00`; }
  function durationLabel(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? `${hours} ч${rest ? ` ${rest} мин` : ''}` : `${rest} мин`;
  }

  function mockResponse(departmentId, date) {
    const offset = departmentId === 'medical' ? 0 : departmentId === 'laboratory' ? 3 : 6;
    const engineers = NAMES.slice(0, departmentId === 'medical' ? 12 : 7).map((name, index) => ({ id: `${departmentId}-engineer-${index}`, name: NAMES[(index + offset) % NAMES.length] }));
    const prefix = `${departmentId}:${date}`;
    const dayOffset = dateObject(date).getDate() % 3;
    const isWeekend = [0, 6].includes(dateObject(date).getDay());
    const events = [];
    const statusMapping = new Map();
    const client = (index) => ({ id: `client-${index % CLIENTS.length}`, name: CLIENTS[index % CLIENTS.length], client_id: `branch-${index % CLIENTS.length}`, client_name: CLIENTS[index % CLIENTS.length], client_address: 'Москва · демонстрационный адрес' });
    const model = (index) => ({ id: `model-${index % MODELS.length}`, name: MODELS[index % MODELS.length] });
    const backups = (index) => engineers.filter((_, i) => (i + index) % 3 !== 2).map((engineer, i) => ({ ...engineer, scoring_points: i === 0 ? 0 : 82 - i * 6 }));
    if (!isWeekend) engineers.forEach((engineer, index) => {
      if (index === 7 || index === 10) return;
      const start = index % 3 === 0 ? 480 : index % 3 === 1 ? 600 : 780;
      const workType = WORK_TYPES[(index + dayOffset) % 3];
      const eligible = backups(index);
      if (!eligible.some((item) => item.id === engineer.id)) eligible.push({ ...engineer, scoring_points: null });
      const event = { id: `${prefix}:event-${index}`, work_type: workType, model: model(index + dayOffset), engineer: { ...engineer }, begin: timeValue(start), end: timeValue(start + 90), duration: 90, client: client(index), backups: eligible, description: 'Плановое обслуживание оборудования. Все данные в этой карточке вымышлены.' };
      events.push(event);
      if (index === 0) statusMapping.set(event.id, 'completed');
      if (index === 2) statusMapping.set(event.id, 'in_progress');
      if (index % 4 === 0) {
        const afternoonStart = start === 780 ? 900 : 840;
        events.push({ ...structuredClone(event), id: `${prefix}:afternoon-${index}`, work_type: 'Ремонт', model: model(index + 2), begin: timeValue(afternoonStart), end: timeValue(afternoonStart + 120), duration: 120 });
      }
    });
    const newEvents = Array.from({ length: departmentId === 'medical' ? 6 : 4 }, (_, index) => ({
      id: `${prefix}:new-${index}`, work_type: WORK_TYPES[(index + dayOffset) % WORK_TYPES.length], model: model(index + 2 + offset), backups: backups(index), client: client(index), is_escalation: index === 4, last_period: null, client_date: null, duration: [90, 60, 120, 45, 90, 60][index], priority: index === 0 || index === 3, is_manual: false, manual_type: null, description: index === 4 ? 'Повторное обращение. Требуется внимание диспетчера.' : null,
    }));
    newEvents.push({ id: `${prefix}:manual`, work_type: null, model: null, backups: null, client: null, is_manual: true, manual_type: 'Обучение', duration: 60, description: 'Обучение работе с новым диагностическим оборудованием' });
    // An optional field spelling from the PDF is deliberately represented in the fixtures.
    newEvents[3].backups = [];
    delete newEvents[5]?.backups;
    newEvents[1].Backups = newEvents[1].backups;
    delete newEvents[1].backups;
    const response = {
      raw: {
        date_config: { date: `${date}T00:00:00`, time_begin: timeValue(480), time_end: timeValue(1020), break_begin: timeValue(720), break_end: timeValue(765) },
        departments: DEPARTMENTS.map((department) => ({ ...department, is_current: department.id === departmentId })),
        engineers,
        absences: isWeekend ? [] : [{ id: `${prefix}:absence`, type: 'Отпуск', id_engineer: engineers[engineers.length - 3], begin: `${date}T00:00:00`, end: `${addDays(date, 1)}T00:00:00` }],
        events, new_events: newEvents,
      },
      statusMapping,
    };
    // Target-day variants are available only in explicitly isolated mock storage.
    const params = new URLSearchParams(location.search);
    if (storageMode && params.get('mockTargetDate') === date) {
      const variant = params.get('mockTargetCase');
      if (variant === 'lunch') { response.raw.date_config.break_begin = timeValue(570); response.raw.date_config.break_end = timeValue(615); }
      if (variant === 'readonly') response.raw.departments.find((department) => department.is_current).permitted = false;
      const engineer = engineers.find((item) => item.id === `${departmentId}-engineer-10`);
      if (variant === 'absence' && engineer) response.raw.absences.push({ id: `${prefix}:test-absence`, type: 'Отпуск', id_engineer: engineer, begin: date, end: date });
      if (variant === 'gap' && engineer) response.raw.events.push({ id: `${prefix}:test-gap`, engineer, begin: timeValue(615), end: timeValue(675), duration: 60, backups: null, is_manual: true, manual_type: 'Событие', description: 'Контроль промежутка на целевом дне' });
    }
    // Layout and malformed-response fixtures are isolated from saved demo data.
    if (storageMode === 'memory' && params.get('mockData') === 'long-text') {
      engineers[0].name = 'Александр-Константинопольский Александрович-Демонстрационный';
      newEvents[0].model.name = 'ДлинноеНазваниеОборудования'.repeat(10);
      newEvents[0].description = 'ОписаниеБезПробелов'.repeat(20);
    }
    if (invalidFixturePending) {
      invalidFixturePending = false;
      newEvents[0].description = { toString: 'invalid' };
    }
    return response;
  }

  const mockHttp = {
    async loadTomorrow(departmentId, date, signal) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, tomorrowDelayMs);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failNextTomorrow) { failNextTomorrow = false; throw new Error('Не удалось загрузить завтрашнее расписание. Попробуйте ещё раз.'); }
      const cached = contexts.get(contextKey(departmentId, date));
      if (cached) return cached;
      const response = await mockHttp.load(departmentId, date);
      return normalize(response.raw, response.statusMapping);
    },
    async NewUserEvent(context, input, signal) {
      const validation = validateManualInput(input);
      if (!validation.ok) throw new Error(Object.values(validation.errors)[0]);
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, createDelayMs);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      });
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (failNextCreate) { failNextCreate = false; throw new Error('Не удалось создать событие. Данные формы сохранены — попробуйте ещё раз.'); }
      return { id: `${context.departmentId}:${context.date}:user:${crypto.randomUUID()}`, work_type: null, model: null, client: null, backups: null, is_manual: true, manual_type: validation.value.type, description: validation.value.description, duration: validation.value.duration, is_escalation: false, priority: false };
    },
    async load(departmentId, date) {
      await new Promise((resolve) => setTimeout(resolve, CONFIG.mockHttpDelayMs));
      if (failNextLoad) { failNextLoad = false; throw new Error('Демонстрационный источник временно недоступен. Попробуйте ещё раз.'); }
      return mockResponse(departmentId, date);
    },
  };

  // Normalization keeps source contracts separate from application state.
  function decode(value) { return typeof value === 'string' ? JSON.parse(value) : value; }
  function object(value, label) {
    const result = decode(value);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`Некорректные данные: ${label}.`);
    return result;
  }
  function array(value, label) {
    if (value == null) return [];
    const result = decode(value);
    if (!Array.isArray(result)) throw new Error(`Ожидался список: ${label}.`);
    return result;
  }
  function named(value, label) {
    const result = object(value, label);
    if (typeof result.id !== 'string' || !result.id.trim() || typeof result.name !== 'string' || !result.name.trim()) throw new Error(`Отсутствует идентификатор или название: ${label}.`);
    return { ...result };
  }
  function unique(items, label) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Повторяющиеся идентификаторы: ${label}.`);
    return items;
  }

  function validateTaskText(source) {
  const optionalText = (value) => value == null || typeof value === 'string';
  if (!['work_type', 'manual_type', 'description'].every((key) => optionalText(source[key]))) throw new Error('Текстовые поля обращения должны быть строками.');
  if (source.model != null) {
    if (typeof source.model !== 'object' || Array.isArray(source.model)) throw new Error('Некорректная модель оборудования.');
    named(source.model, 'модель оборудования');
  }
  if (source.client != null) {
    if (typeof source.client !== 'object' || Array.isArray(source.client) || !['id', 'name', 'client_id', 'client_name', 'client_address'].every((key) => optionalText(source.client[key]))) throw new Error('Некорректные текстовые поля заказчика.');
  }
  }

  function normalize(rawValue, statusMapping = new Map()) {
    const raw = structuredClone(object(rawValue, 'расписание'));
    const config = object(raw.date_config, 'параметры даты');
    const date = parseDate(config.date);
    const start = parseTime(config.time_begin, date);
    const end = parseTime(config.time_end, date);
    const lunchStart = parseTime(config.break_begin, date);
    const lunchEnd = parseTime(config.break_end, date);
    if (!(start < lunchStart && lunchStart < lunchEnd && lunchEnd < end)) throw new Error('Обед должен находиться внутри рабочего дня и иметь положительную длительность.');
    const departments = unique(array(raw.departments, 'подразделения').map((item) => ({ ...named(item, 'подразделение'), permitted: item.permitted === true })), 'подразделения');
    const currentDepartment = departments.find((item) => item.is_current === true) || departments[0] || null;
    const engineers = unique(array(raw.engineers, 'специалисты').map((item) => named(item, 'специалист')), 'специалисты');
    const engineerIds = new Set(engineers.map((item) => item.id));
    const absences = array(raw.absences, 'отсутствия').map((item) => {
      const absence = object(item, 'отсутствие');
      if (absence.type != null && typeof absence.type !== 'string') throw new Error('Тип отсутствия должен быть строкой.');
      const begin = parseDate(absence.begin, false);
      const finish = parseDate(absence.end, false);
      const engineer = named(absence.id_engineer, 'отсутствующий специалист');
      if (finish < begin || !engineerIds.has(engineer.id)) throw new Error('Некорректный период отсутствия или специалист.');
      return { ...absence, begin, end: finish, id_engineer: engineer };
    });
    const normalizeTask = (value, assigned) => {
      const source = object(value, 'обращение');
      validateTaskText(source);
      if (typeof source.id !== 'string' || !source.id.trim() || !Number.isSafeInteger(source.duration) || source.duration <= 0) throw new Error('У обращения должны быть идентификатор и положительная целая длительность.');
      const eligible = source.backups === undefined ? source.Backups : source.backups;
      const backups = eligible == null ? null : unique(array(eligible, 'компетенции').map((item) => named(item, 'компетенция')), 'компетенции');
      let assignment = null;
      if (assigned) {
        const engineer = named(source.engineer, 'исполнитель');
        const begin = parseTime(source.begin, date);
        const finish = parseTime(source.end, date);
        if (!engineerIds.has(engineer.id) || finish - begin !== source.duration || begin < start || finish > end) throw new Error('Назначение содержит неизвестного специалиста или несогласованный интервал.');
        assignment = { engineerId: engineer.id, begin, end: finish };
      }
      const defaultStatus = assigned ? 'planned' : 'open';
      const mapped = statusMapping.get(source.id);
      const allowedStatuses = assigned ? ['planned', 'in_progress', 'completed'] : ['open', 'deferred'];
      return { id: source.id, source, departmentId: currentDepartment?.id ?? null, date, assignment, backups, status: allowedStatuses.includes(mapped) ? mapped : defaultStatus, isEscalation: source.is_escalation === true, actualStartedAt: null, actualCompletedAt: null, plannedAssignment: null, history: [] };
    };
    const tasks = unique([...array(raw.events, 'события').map((item) => normalizeTask(item, true)), ...array(raw.new_events, 'очередь').map((item) => normalizeTask(item, false))], 'обращения');
    return { raw, date, config: { start, end, lunchStart, lunchEnd }, departments, currentDepartment, engineers, absences, tasks };
  }

  // Persistent contexts retain original responses and separate editable task metadata.
  function contextKey(departmentId, date) { return `${departmentId}:${date}`; }
  function taskState(task) {
    return { id: task.id, assignment: task.assignment, status: task.status, actualStartedAt: task.actualStartedAt, actualCompletedAt: task.actualCompletedAt, plannedAssignment: task.plannedAssignment, history: task.history };
  }
  function restoreContext(saved) {
    const data = normalize(saved.raw);
    if (!data.currentDepartment || !Array.isArray(saved.taskStates) || saved.taskStates.length !== data.tasks.length) throw new Error('Invalid saved context');
    const metadata = new Map(unique(saved.taskStates, 'сохранённые задачи').map((item) => [item.id, item]));
    const originalAssignments = new Map(data.tasks.map((task) => [task.id, task.assignment]));
    data.tasks = data.tasks.map((task) => {
      const item = metadata.get(task.id);
      if (!item || !Array.isArray(item.history)) throw new Error('Invalid saved task');
      const assignment = item.assignment;
      const plan = item.plannedAssignment ?? null;
      const validAssignment = (value) => value && data.engineers.some((engineer) => engineer.id === value.engineerId) && Number.isInteger(value.begin) && Number.isInteger(value.end) && value.begin >= data.config.start && value.end <= data.config.end && value.end > value.begin;
      if (assignment !== null && !validAssignment(assignment)) throw new Error('Invalid saved assignment');
      if (!(assignment ? ['planned', 'in_progress', 'completed'] : ['open', 'deferred']).includes(item.status)) throw new Error('Invalid saved status');
      if (plan && (!validAssignment(plan) || !assignment || plan.engineerId !== assignment.engineerId || plan.begin !== assignment.begin || plan.end - plan.begin !== task.source.duration || assignment.end > plan.end || item.status !== 'completed')) throw new Error('Invalid saved plan');
      if (assignment && !plan && assignment.end - assignment.begin !== task.source.duration) throw new Error('Invalid saved duration');
      for (const field of ['actualStartedAt', 'actualCompletedAt']) {
        const value = item[field];
        if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || new Date(value).getSeconds() !== 0 || new Date(value).getMilliseconds() !== 0)) throw new Error('Invalid saved actual time');
      }
      if (item.actualStartedAt && (!assignment || !['in_progress', 'completed'].includes(item.status) || localDate(new Date(item.actualStartedAt)) !== task.date || new Date(item.actualStartedAt) < scheduledAt(task, assignment.begin))) throw new Error('Invalid saved start');
      if (item.actualCompletedAt) {
        const finished = new Date(item.actualCompletedAt);
        if (!assignment || !plan || item.status !== 'completed' || finished <= scheduledAt(task, plan.begin) || (item.actualStartedAt && finished < new Date(item.actualStartedAt))) throw new Error('Invalid saved completion');
        const occupiedEnd = localDate(finished) === task.date ? Math.min(plan.end, finished.getHours() * 60 + finished.getMinutes()) : plan.end;
        if (assignment.end !== occupiedEnd) throw new Error('Invalid saved occupied interval');
      } else if (plan) throw new Error('Missing saved completion');
      for (const entry of item.history) {
        if (!entry || !['NewPlanning', 'MoveEvent', 'ReturnToQueue', 'StartWork', 'Defer', 'Complete', 'MoveToTomorrow'].includes(entry.action) || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || !Object.hasOwn(entry, 'before') || !Object.hasOwn(entry, 'after')) throw new Error('Invalid saved history');
      }
      return { ...task, assignment: structuredClone(assignment), plannedAssignment: structuredClone(plan), status: item.status, actualStartedAt: item.actualStartedAt, actualCompletedAt: item.actualCompletedAt, history: structuredClone(item.history) };
    });
    for (const task of data.tasks) {
      const original = originalAssignments.get(task.id);
      const current = task.assignment;
      const unchanged = original === null ? current === null : current && original.engineerId === current.engineerId && original.begin === current.begin && current.end <= original.end;
      // Original server fixtures may intentionally contain an old absence conflict.
      if (!unchanged && (!data.currentDepartment.permitted || (current && !validateAssignment(data, { ...task, status: 'planned', source: { ...task.source, duration: occupiedDuration(task) } }, current.engineerId, current.begin).ok))) throw new Error('Invalid saved planning');
    }
    return data;
  }
  function restoreDemo() {
    try {
      const savedText = storage.read();
      if (savedText === null) return;
      const saved = JSON.parse(savedText);
      if (saved.version !== 1 || !Array.isArray(saved.contexts) || !saved.selection || typeof saved.selection.departmentId !== 'string') throw new Error('Invalid saved version');
      const restored = saved.contexts.map(restoreContext);
      const keys = restored.map((data) => contextKey(data.currentDepartment.id, data.date));
      const taskIds = restored.flatMap((data) => data.tasks.map((task) => task.id));
      if (new Set(taskIds).size !== taskIds.length) throw new Error('Duplicate task across contexts');
      if (new Set(keys).size !== keys.length) throw new Error('Duplicate saved context');
      const date = parseDate(saved.selection.date);
      if (!keys.includes(contextKey(saved.selection.departmentId, date))) throw new Error('Invalid saved selection');
      if (saved.stream !== undefined) {
        const stream = saved.stream;
        if (!stream || !validWsSettings(stream) || typeof stream.paused !== 'boolean' || !Number.isInteger(stream.generated) || stream.generated < 0 || stream.generated > 1000 || !Array.isArray(stream.receipts) || stream.receipts.length > 2000 || stream.receipts.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) || new Set(stream.receipts).size !== stream.receipts.length) throw new Error('Invalid saved stream');
        wsSettings = { intervalMs: stream.intervalMs, maxMessages: stream.maxMessages, paused: stream.paused, generated: stream.generated };
        wsReceipts = new Set(stream.receipts);
      }
      restored.forEach((data, index) => contexts.set(keys[index], data));
      state.date = date; state.departmentId = saved.selection.departmentId;
    } catch (error) {
      storageBlocked = true;
      storageNotice = 'Не удалось восстановить демо: хранилище недоступно или данные повреждены. Работа продолжается в памяти; изменения не сохранятся после перезагрузки. Для повторной попытки используйте «Сбросить демо».';
    }
  }
  function saveDemo() {
    const selected = contexts.get(contextKey(state.departmentId, state.date)) || contexts.values().next().value;
    if (!selected) { renderStorageStatus(); return; }
    if (!storageBlocked) {
      try {
        storage.write(JSON.stringify({ version: 1, stream: { ...wsSettings, receipts: [...wsReceipts] }, selection: { date: selected.date, departmentId: selected.currentDepartment.id }, contexts: [...contexts.values()].map((data) => ({ raw: data.raw, taskStates: data.tasks.map(taskState) })) }));
        storageNotice = '';
      } catch (error) {
        storageBlocked = true;
        storageNotice = 'Не удалось сохранить демо. Работа продолжается в памяти; изменения не сохранятся после перезагрузки.';
      }
    }
    renderStorageStatus();
  }
  function renderStorageStatus() {
    $('storage-warning').hidden = !storageNotice;
    $('storage-warning').textContent = storageNotice;
    $('storage-status').textContent = storageBlocked ? 'Только в памяти' : storageMode ? 'Проверка хранилища · отдельное демо' : 'Сохраняется в этом браузере';
  }

  // The same validator serves all planning operations, independent of the UI.
  function validateAssignment(data, task, engineerId, begin) {
    const reject = (message, field = 'assignment-time') => ({ ok: false, message, field });
    if (!data?.currentDepartment?.permitted) return reject('В этом подразделении доступен только просмотр.', 'assignment-engineer');
    if (!task || task.status === 'completed') return reject('Завершённое обращение доступно только для просмотра.');
    if (!CONFIG.workingWeekdays.includes(dateObject(data.date).getDay())) return reject('Выбранный день нерабочий. Выберите рабочую дату.');
    const engineer = data.engineers.find((item) => item.id === engineerId);
    if (!engineer) return reject('Выберите специалиста.', 'assignment-engineer');
    if (task.backups !== null && !task.backups.some((item) => item.id === engineerId)) return reject('У специалиста нет необходимой компетенции для этого обращения.', 'assignment-engineer');
    if (data.absences.some((item) => item.id_engineer.id === engineerId && item.begin <= data.date && item.end >= data.date)) return reject('Специалист отсутствует в выбранную дату.', 'assignment-engineer');
    if (!Number.isInteger(begin) || begin % CONFIG.slotStepMinutes !== 0) return reject(`Укажите время начала с шагом ${CONFIG.slotStepMinutes} минут.`);
    const end = begin + task.source.duration;
    const { start, end: dayEnd, lunchStart, lunchEnd } = data.config;
    if (begin < start || end > dayEnd) return reject(`Событие должно целиком помещаться в рабочее время ${clock(start)}–${clock(dayEnd)}.`);
    if (begin < lunchEnd && end > lunchStart) return reject(`Событие пересекает обед ${clock(lunchStart)}–${clock(lunchEnd)}.`);
    for (const other of data.tasks) {
      if (other.id === task.id || other.assignment?.engineerId !== engineerId) continue;
      const occupied = other.assignment;
      if (begin < occupied.end + CONFIG.minGapMinutes && end + CONFIG.minGapMinutes > occupied.begin) return reject(`Нужен интервал ${CONFIG.minGapMinutes} минут до и после события «${workTitle(other)}» (${clock(occupied.begin)}–${clock(occupied.end)}).`);
    }
    return { ok: true, assignment: { engineerId, begin, end } };
  }
  function commitPlanning(id, assignment, action) {
    if (!state.data || state.loading) return { ok: false, message: 'Дождитесь загрузки расписания.' };
    const data = state.data;
    const task = data.tasks.find((item) => item.id === id);
    if (!task || !data.currentDepartment?.permitted || task.status === 'completed') return { ok: false, message: 'Это обращение доступно только для просмотра.' };
    if ((action === 'NewPlanning' && task.assignment) || (action !== 'NewPlanning' && !task.assignment)) return { ok: false, message: 'Назначение уже изменилось. Откройте карточку заново.' };
    if (assignment) {
      const validation = validateAssignment(data, task, assignment.engineerId, assignment.begin);
      if (!validation.ok) return validation;
      assignment = validation.assignment;
    }
    const nextTask = { ...task, assignment, status: assignment ? 'planned' : 'open', actualStartedAt: null, actualCompletedAt: null, plannedAssignment: null, history: [...task.history, { action, at: now().toISOString(), before: { assignment: task.assignment, status: task.status, actualStartedAt: task.actualStartedAt }, after: { assignment, status: assignment ? 'planned' : 'open' } }] };
    applyData({ ...data, tasks: data.tasks.map((item) => item.id === id ? nextTask : item) });
    return { ok: true };
  }
  const planningActions = Object.freeze({
    NewPlanning: (id, engineerId, begin) => commitPlanning(id, { engineerId, begin }, 'NewPlanning'),
    MoveEvent: (id, engineerId, begin) => commitPlanning(id, { engineerId, begin }, 'MoveEvent'),
    ReturnToQueue: (id) => commitPlanning(id, null, 'ReturnToQueue'),
  });

  // Status changes are atomic and revalidated at submission, including the current demo clock.
  function validateStatus(task, action, finishedAt) {
    const reject = (message) => ({ ok: false, message });
    if (!state.data || state.loading) return reject('Дождитесь загрузки расписания.');
    if (!task || !state.data.currentDepartment?.permitted || task.status === 'completed') return reject('Это обращение доступно только для просмотра.');
    if (!task.assignment || !['planned', 'in_progress'].includes(task.status)) return reject('Сначала назначьте обращение специалисту.');
    if (action === 'Defer') return { ok: true };
    if (action === 'StartWork') {
      if (task.status !== 'planned') return reject('Работа уже начата.');
      if (task.date !== localDate(now())) return reject('Начать работу можно только в сегодняшнем расписании.');
      if (minuteNow() < scheduledAt(task, task.assignment.begin)) return reject('Время начала ещё не наступило.');
      return { ok: true };
    }
    if (action !== 'Complete') return reject('Неизвестное действие.');
    const finish = parseDemoNow(finishedAt);
    if (!finish) return reject('Укажите корректные дату и время завершения.');
    if (finish > now()) return reject('Фактическое завершение не может быть в будущем.');
    if (finish <= scheduledAt(task, task.assignment.begin)) return reject('Завершение должно быть строго после начала назначенного интервала.');
    if (task.actualStartedAt && finish < new Date(task.actualStartedAt)) return reject('Завершение не может быть раньше фактического начала работы.');
    return { ok: true, finish };
  }
  function commitStatus(action) {
    const task = state.data?.tasks.find((item) => item.id === activeTaskId);
    const result = validateStatus(task, action, $('completion-time').value);
    if (!result.ok) { $('status-error').textContent = result.message; $('status-error').hidden = false; return; }
    const before = { assignment: task.assignment, status: task.status, actualStartedAt: task.actualStartedAt, actualCompletedAt: task.actualCompletedAt };
    const next = { ...task };
    if (action === 'StartWork') { next.status = 'in_progress'; next.actualStartedAt = minuteNow().toISOString(); }
    if (action === 'Defer') { next.status = 'deferred'; next.assignment = null; next.actualStartedAt = null; next.actualCompletedAt = null; next.plannedAssignment = null; }
    if (action === 'Complete') {
      next.status = 'completed'; next.actualCompletedAt = result.finish.toISOString(); next.plannedAssignment = { ...task.assignment };
      const minutes = localDate(result.finish) === task.date ? result.finish.getHours() * 60 + result.finish.getMinutes() : task.assignment.end;
      next.assignment = { ...task.assignment, end: Math.min(task.assignment.end, minutes) };
    }
    next.history = [...task.history, { action, at: now().toISOString(), before, after: { assignment: next.assignment, status: next.status, actualStartedAt: next.actualStartedAt, actualCompletedAt: next.actualCompletedAt } }];
    applyData({ ...state.data, tasks: state.data.tasks.map((item) => item.id === task.id ? next : item) });
    finishPlanning(task.id, action === 'Defer' ? 'Обращение отложено и возвращено в очередь.' : action === 'StartWork' ? 'Работа начата.' : 'Обращение выполнено. Фактическое время сохранено.');
  }

  // Transfer prepares both contexts before publishing either side or saving a snapshot.
  function cancelTomorrow() {
    if (!tomorrowTransfer) return;
    const session = tomorrowTransfer;
    tomorrowTransfer = null;
    session.controller.abort();
    for (const [control, disabled] of session.controls) if (control.isConnected) control.disabled = disabled;
    $('details-dialog').removeAttribute('aria-busy');
    $('tomorrow-progress').textContent = '';
  }
  async function moveToTomorrow() {
    if (tomorrowTransfer || state.loading) return;
    const origin = state.data;
    const task = origin?.tasks.find((item) => item.id === activeTaskId);
    if (!task?.assignment || !origin.currentDepartment?.permitted || !['planned', 'in_progress'].includes(task.status)) return;
    let date;
    try { date = parseDate(addDays(task.date, 1)); }
    catch (error) { $('status-error').textContent = error.message; $('status-error').hidden = false; return; }
    const departmentId = origin.currentDepartment.id;
    const fromKey = contextKey(departmentId, task.date);
    const toKey = contextKey(departmentId, date);
    const session = { controller: new AbortController(), controls: [...document.querySelectorAll('#status-form button, #status-form input, #assignment-form button, #assignment-form input, #assignment-form select')].map((control) => [control, control.disabled]), requestId: state.requestId };
    tomorrowTransfer = session;
    session.controls.forEach(([control]) => { control.disabled = true; });
    $('details-dialog').setAttribute('aria-busy', 'true');
    $('status-error').hidden = true;
    $('tomorrow-progress').textContent = `Проверяем расписание на ${dateObject(date).toLocaleDateString('ru-RU')}… Закрытие карточки отменит перенос.`;
    try {
      const loaded = await mockHttp.loadTomorrow(departmentId, date, session.controller.signal);
      if (tomorrowTransfer !== session || session.controller.signal.aborted) return;
      if (!$('details-dialog').open || activeTaskId !== task.id) { cancelTomorrow(); return; }
      const current = contexts.get(fromKey);
      if (session.requestId !== state.requestId || state.loading || state.departmentId !== departmentId || state.date !== task.date || !current?.currentDepartment?.permitted || current.tasks.find((item) => item.id === task.id) !== task) throw new Error('Исходное назначение изменилось. Откройте карточку заново.');
      const target = contexts.get(toKey) || loaded;
      if (target.date !== date || target.currentDepartment?.id !== departmentId) throw new Error('Получено расписание другого подразделения или даты.');
      if ([...contexts.entries()].some(([key, data]) => key !== fromKey && data.tasks.some((item) => item.id === task.id)) || target.tasks.some((item) => item.id === task.id)) throw new Error('Обращение с этим идентификатором уже существует в другом расписании.');
      const candidate = { ...task, date, departmentId, status: 'planned' };
      const result = validateAssignment(target, candidate, task.assignment.engineerId, task.assignment.begin);
      if (!result.ok) throw new Error(result.message);
      const source = { ...structuredClone(task.source), engineer: structuredClone(target.engineers.find((item) => item.id === result.assignment.engineerId)), begin: timeValue(result.assignment.begin), end: timeValue(result.assignment.end) };
      const moved = { ...candidate, source, assignment: result.assignment, plannedAssignment: null, actualStartedAt: null, actualCompletedAt: null,
        history: [...task.history, { action: 'MoveToTomorrow', at: now().toISOString(), before: { date: task.date, assignment: task.assignment, status: task.status, actualStartedAt: task.actualStartedAt, actualCompletedAt: task.actualCompletedAt }, after: { date, assignment: result.assignment, status: 'planned' } }] };
      const from = { ...current, tasks: current.tasks.filter((item) => item.id !== task.id), raw: { ...current.raw, events: array(current.raw.events, 'события').filter((item) => item.id !== task.id), new_events: array(current.raw.new_events, 'очередь').filter((item) => item.id !== task.id) } };
      const to = { ...target, tasks: [...target.tasks, moved], raw: { ...target.raw, events: [...array(target.raw.events, 'события'), source] } };
      // No awaits after preparation: saveDemo sees both sides in one snapshot.
      cancelTomorrow();
      contexts.set(toKey, to);
      applyData(from);
      finishPlanning(task.id, `Обращение перенесено на ${dateObject(date).toLocaleDateString('ru-RU')}. Специалист и время сохранены.`);
      const link = el('button', 'quiet-button transfer-date', 'Перейти к дате');
      link.addEventListener('click', () => selectDate(date));
      $('message').append(link);
    } catch (error) {
      if (tomorrowTransfer !== session || session.controller.signal.aborted) return;
      $('status-error').textContent = `Перенос не выполнен. ${error.message}`;
      $('status-error').hidden = false;
    } finally {
      if (tomorrowTransfer === session) cancelTomorrow();
    }
  }

  // The emulator and real transports share one serialized-message boundary.
  function validWsSettings(value) {
    return Number.isInteger(value.intervalMs) && value.intervalMs >= 1000 && value.intervalMs <= 300000 && value.intervalMs % 1000 === 0 && Number.isInteger(value.maxMessages) && value.maxMessages >= 1 && value.maxMessages <= 1000;
  }
  function renderWsStatus() {
    const limited = wsSettings.generated >= wsSettings.maxMessages;
    $('ws-status').textContent = limited ? `Предел достигнут · добавлено ${wsSettings.generated}` : wsSettings.paused ? `Пауза · добавлено ${wsSettings.generated}` : `Работает · каждые ${wsSettings.intervalMs / 1000} сек · добавлено ${wsSettings.generated}`;
    $('ws-toggle').textContent = wsSettings.paused ? 'Возобновить' : 'Пауза';
    $('ws-toggle').disabled = limited;
    $('ws-notice').textContent = wsNotice;
    $('ws-pending').hidden = !queueRefreshPending;
  }
  function syncWsInputs() {
    $('ws-interval').value = wsSettings.intervalMs / 1000;
    $('ws-limit').value = wsSettings.maxMessages;
    renderWsStatus();
  }
  function requestQueueRefresh() {
    queueRefreshPending = true;
    const count = state.data.tasks.filter((task) => !task.assignment).length;
    $('queue-count').textContent = count; $('mobile-count').textContent = count;
    flushQueueRefresh();
  }
  function flushQueueRefresh() {
    if (!queueRefreshPending || !state.data || state.loading || dragController.isBusy() || document.querySelector('dialog[open]') || document.activeElement?.closest('.queue-card')) { renderWsStatus(); return; }
    const scrollTop = $('queue-list').scrollTop;
    renderQueue();
    $('queue-list').scrollTop = scrollTop;
    renderWsStatus();
  }
  async function receiveWsMessage(serialized) {
    const resetVersion = wsResetVersion;
    try {
      if (typeof serialized !== 'string' || serialized.length > 100000) throw new Error('Ожидается JSON-сообщение допустимого размера.');
      const message = object(JSON.parse(serialized), 'сообщение потока');
      if (typeof message.id !== 'string' || !message.id.trim() || message.id.length > 200 || typeof message.departmentId !== 'string' || ![...DEPARTMENTS, ...(state.data?.departments || [])].some((item) => item.id === message.departmentId) || !/^\d{4}-\d{2}-\d{2}$/.test(message.date) || parseDate(message.date) !== message.date) throw new Error('Некорректный идентификатор, подразделение или дата сообщения.');
      const source = object(message.event, 'обращение потока');
      if (typeof source.id !== 'string' || !source.id.trim() || source.id.length > 200 || !Number.isSafeInteger(source.duration) || source.duration <= 0 || (source.is_manual !== undefined && typeof source.is_manual !== 'boolean') || (source.is_escalation !== undefined && typeof source.is_escalation !== 'boolean') || (source.priority !== undefined && typeof source.priority !== 'boolean')) throw new Error('Некорректные поля обращения.');
      validateTaskText(source);
      if (source.is_manual) {
        if (!MANUAL_TYPES.includes(source.manual_type) || typeof source.description !== 'string' || !source.description.trim()) throw new Error('Некорректное ручное событие.');
      } else {
        if (typeof source.work_type !== 'string' || !source.work_type.trim()) throw new Error('Не указан вид работ.');
        named(source.model, 'модель оборудования');
      }
      const duplicate = () => wsReceipts.has(message.id) || [...contexts.values()].some((data) => data.tasks.some((task) => task.id === source.id));
      if (duplicate()) { wsNotice = 'Повторное сообщение пропущено. Назначения и статусы сохранены.'; renderWsStatus(); return { accepted: false, duplicate: true }; }
      if (wsReceipts.size >= 2000) throw new Error('Достигнут предел приёма сообщений демо.');
      const key = contextKey(message.departmentId, message.date);
      let data = contexts.get(key);
      if (!data) {
        const response = await mockHttp.load(message.departmentId, message.date);
        if (resetVersion !== wsResetVersion) return { accepted: false, cancelled: true };
        data = contexts.get(key) || normalize(response.raw, response.statusMapping);
      }
      if (data.date !== message.date || data.currentDepartment?.id !== message.departmentId) throw new Error('Контекст сообщения не совпал с расписанием.');
      if (duplicate() || data.tasks.some((task) => task.id === source.id)) { wsNotice = 'Повторное сообщение пропущено. Назначения и статусы сохранены.'; renderWsStatus(); return { accepted: false, duplicate: true }; }
      if (wsReceipts.size >= 2000) throw new Error('Достигнут предел приёма сообщений демо.');
      const task = normalize({ ...data.raw, events: [], new_events: [source] }).tasks[0];
      const next = { ...data, tasks: [...data.tasks, task], raw: { ...data.raw, new_events: [...array(data.raw.new_events, 'очередь'), task.source] } };
      contexts.set(key, next); wsReceipts.add(message.id);
      if (!state.loading && contextKey(state.departmentId, state.date) === key) { state.data = next; requestQueueRefresh(); }
      saveDemo();
      wsNotice = `Новое обращение · ${data.currentDepartment.name} · ${dateObject(message.date).toLocaleDateString('ru-RU')}`;
      renderWsStatus();
      return { accepted: true };
    } catch (error) {
      if (resetVersion !== wsResetVersion) return { accepted: false, cancelled: true };
      wsNotice = `Сообщение не принято. ${error instanceof SyntaxError ? 'Некорректный JSON.' : error.message}`;
      renderWsStatus();
      return { accepted: false, error: true };
    }
  }
  function makeWsMessage(departmentId, date, description = 'Новое обращение из демонстрационного потока') {
    return JSON.stringify({ id: `message:${crypto.randomUUID()}`, departmentId, date, event: { id: `incoming:${crypto.randomUUID()}`, work_type: WORK_TYPES[wsSettings.generated % 3], model: { id: 'demo-model', name: MODELS[wsSettings.generated % MODELS.length] }, client: { id: 'demo-client', name: CLIENTS[wsSettings.generated % CLIENTS.length] }, duration: [30, 45, 60][wsSettings.generated % 3], backups: null, is_manual: false, is_escalation: wsSettings.generated % 5 === 4, priority: false, description } });
  }
  function restartWsTimer() {
    clearTimeout(wsTimer); wsTimer = null;
    const version = ++wsTimerVersion;
    if (wsSettings.paused || wsSettings.generated >= wsSettings.maxMessages) { renderWsStatus(); return; }
    wsTimer = setTimeout(async () => {
      wsTimer = null;
      if (version !== wsTimerVersion) return;
      const resetVersion = wsResetVersion;
      if (state.data && !state.loading) {
        const result = await receiveWsMessage(makeWsMessage(state.departmentId, state.date));
        if (resetVersion !== wsResetVersion) return;
        if (result.accepted) { wsSettings.generated += 1; saveDemo(); }
      }
      renderWsStatus();
      if (version === wsTimerVersion) restartWsTimer();
    }, wsSettings.intervalMs);
    renderWsStatus();
  }
  function saveWsSettings(event) {
    event.preventDefault();
    const intervalMs = Number($('ws-interval').value) * 1000;
    const maxMessages = Number($('ws-limit').value);
    if (!validWsSettings({ intervalMs, maxMessages })) { $('ws-error').textContent = 'Интервал: целое число от 1 до 300 секунд. Предел: от 1 до 1000 обращений.'; $('ws-error').hidden = false; return; }
    $('ws-error').hidden = true;
    wsSettings = { ...wsSettings, intervalMs, maxMessages };
    saveDemo(); restartWsTimer();
  }
  window.ReceiveWsMessage = receiveWsMessage;

  // Pointer dragging owns only transient visuals; every drop uses the planning operations.
  const dragController = (() => {
    let drag = null;
    let frame = 0;
    let suppressClick = false;
    const narrow = matchMedia('(max-width: 1100px)');
    const preview = el('div', 'drop-preview'); preview.setAttribute('aria-hidden', 'true');
    const tooltip = $('drag-tooltip');
    const scroller = $('calendar-scroll');
    const queue = $('queue-panel');
    const inside = (rect, x, y) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;

    function announce(text) {
      if ($('drag-status').textContent !== text) $('drag-status').textContent = text;
    }
    function notify(text) { $('message').textContent = text; $('message').hidden = false; }
    function cleanup() {
      const previous = drag;
      drag = null;
      cancelAnimationFrame(frame); frame = 0;
      preview.remove(); tooltip.hidden = true;
      queue.classList.remove('drop-allowed', 'drop-denied');
      document.body.classList.remove('is-dragging');
      previous?.card.classList.remove('drag-source');
      if (previous?.card.hasPointerCapture(previous.pointerId)) previous.card.releasePointerCapture(previous.pointerId);
      queueMicrotask(flushQueueRefresh);
      return previous;
    }
    function cancel(message = 'Перетаскивание отменено.') {
      if (!drag) return;
      const wasActive = drag.active;
      suppressClick = wasActive;
      cleanup();
      if (wasActive) { announce(message); notify(message); }
    }
    function targetAtPointer() {
      const task = state.data?.tasks.find((item) => item.id === drag.id);
      if (!task || task !== drag.data.tasks.find((item) => item.id === drag.id) || state.data.date !== drag.data.date || state.data.currentDepartment?.id !== drag.data.currentDepartment?.id) return { ok: false, message: 'Расписание изменилось. Повторите перенос.' };
      const hit = document.elementFromPoint(drag.x, drag.y);
      if (hit && queue.contains(hit)) {
        return task.assignment ? { ok: true, kind: 'queue', message: 'Вернуть в очередь · статус «Открыта»' } : { ok: false, message: 'Обращение уже находится в очереди.' };
      }
      const timeline = hit?.closest('.timeline[data-engineer-id]');
      const bounds = scroller.getBoundingClientRect();
      if (!timeline || !scroller.contains(timeline) || !inside(bounds, drag.x, drag.y)) return { ok: false, message: 'Перенесите карточку на строку специалиста или в очередь.' };
      const rect = timeline.getBoundingClientRect();
      const { start, end } = state.data.config;
      const begin = Math.round((start + (drag.x - rect.left) / rect.width * (end - start) - drag.grabMinutes) / CONFIG.slotStepMinutes) * CONFIG.slotStepMinutes;
      const engineerId = timeline.dataset.engineerId;
      const engineer = state.data.engineers.find((item) => item.id === engineerId);
      const validation = validateAssignment(state.data, task, engineerId, begin);
      const score = task.backups?.find((item) => item.id === engineerId)?.scoring_points;
      const scoreText = Number.isFinite(score) ? ` · ${score} баллов` : '';
      const interval = `${clock(begin)}–${clock(begin + task.source.duration)}`;
      return { ...validation, kind: 'calendar', timeline, begin, engineerId, interval, message: `${engineer.name} · ${interval}${scoreText}. ${validation.ok ? 'Отпустите, чтобы назначить.' : validation.message}` };
    }
    function updatePreview() {
      const target = targetAtPointer();
      drag.target = target;
      preview.remove();
      queue.classList.toggle('drop-allowed', target.kind === 'queue' && target.ok);
      queue.classList.toggle('drop-denied', !target.ok && inside(queue.getBoundingClientRect(), drag.x, drag.y));
      if (target.kind === 'calendar') {
        preview.className = `drop-preview ${target.ok ? 'allowed' : 'denied'}`;
        const { start, end } = state.data.config;
        const duration = drag.data.tasks.find((item) => item.id === drag.id).source.duration;
        const left = Math.min(end, Math.max(start, target.begin));
        const right = Math.max(start, Math.min(end, target.begin + duration));
        preview.style.left = `${(left - start) / (end - start) * 100}%`;
        preview.style.width = `${Math.max(0, right - left) / (end - start) * 100}%`;
        preview.textContent = `${target.ok ? '✓' : '×'} ${target.interval}`;
        if (right > left) target.timeline.append(preview);
      }
      tooltip.classList.toggle('denied', !target.ok);
      tooltip.textContent = `${target.message} Escape — отменить.`;
      tooltip.hidden = false;
      tooltip.style.left = `${Math.max(8, Math.min(drag.x + 16, innerWidth - 324))}px`;
      tooltip.style.top = `${Math.max(8, Math.min(drag.y + 18, innerHeight - tooltip.offsetHeight - 8))}px`;
      announce(target.message);
    }
    function autoScroll(time) {
      if (!drag?.active) return;
      const dt = Math.min(32, time - (drag.lastFrame || time)); drag.lastFrame = time;
      const rect = scroller.getBoundingClientRect();
      const corner = scroller.querySelector('.calendar-header .engineer-cell')?.getBoundingClientRect();
      if (corner && inside(rect, drag.x, drag.y) && drag.x > corner.right && drag.y > corner.bottom) {
        const edgeSpeed = (value, low, high) => value < low + 36 ? -Math.min(1, (low + 36 - value) / 36) : value > high - 36 ? Math.min(1, (value - high + 36) / 36) : 0;
        const dx = edgeSpeed(drag.x, corner.right, rect.right) * dt * .65;
        const dy = edgeSpeed(drag.y, corner.bottom, rect.bottom) * dt * .65;
        if (dx || dy) { scroller.scrollLeft += dx; scroller.scrollTop += dy; updatePreview(); }
      }
      frame = requestAnimationFrame(autoScroll);
    }
    document.addEventListener('pointerdown', (event) => {
      if (drag || !event.isPrimary || event.button !== 0) return;
      suppressClick = false;
      const card = event.target.closest('[data-draggable="true"]');
      if (!card || narrow.matches || event.pointerType === 'touch' || state.loading || document.querySelector('dialog[open]')) return;
      const task = state.data?.tasks.find((item) => item.id === card.dataset.taskId);
      if (!task || !state.data.currentDepartment?.permitted || task.status === 'completed') return;
      const timeline = card.closest('.timeline');
      let grabMinutes = 0;
      if (task.assignment && timeline) {
        const rect = timeline.getBoundingClientRect();
        const { start, end } = state.data.config;
        grabMinutes = Math.max(0, Math.min(task.source.duration, (event.clientX - rect.left) / rect.width * (end - start) - task.assignment.begin + start));
      }
      drag = { id: task.id, card, pointerId: event.pointerId, data: state.data, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, grabMinutes };
      card.setPointerCapture(event.pointerId);
    });
    document.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
      event.preventDefault();
      if (!drag.active) {
        drag.active = true;
        drag.card.classList.add('drag-source'); document.body.classList.add('is-dragging');
        frame = requestAnimationFrame(autoScroll);
        if (injectOnDrag) { injectOnDrag = false; void receiveWsMessage(makeWsMessage(state.departmentId, state.date, 'Поступило во время перетаскивания')); }
      }
      updatePreview();
    });
    document.addEventListener('pointerup', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) { cleanup(); return; }
      event.preventDefault(); suppressClick = true;
      drag.x = event.clientX; drag.y = event.clientY;
      const target = targetAtPointer();
      const previous = cleanup();
      if (!target.ok) { notify(`Перенос не выполнен. ${target.message}`); announce(target.message); return; }
      const task = state.data.tasks.find((item) => item.id === previous.id);
      const result = target.kind === 'queue' ? planningActions.ReturnToQueue(task.id) : (task.assignment ? planningActions.MoveEvent : planningActions.NewPlanning)(task.id, target.engineerId, target.begin);
      const message = result.ok ? target.kind === 'queue' ? 'Обращение возвращено в очередь.' : `Назначение изменено: ${target.interval}.` : `Перенос не выполнен. ${result.message}`;
      notify(message); announce(message);
      if (result.ok) {
        const card = [...document.querySelectorAll('[data-task-id]')].find((node) => node.dataset.taskId === previous.id);
        (card || $('schedule-title')).focus({ preventScroll: true });
      }
    });
    document.addEventListener('click', (event) => {
      if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
    }, true);
    document.addEventListener('dragstart', (event) => { if (event.target.closest('[data-draggable="true"]')) event.preventDefault(); });
    document.addEventListener('pointercancel', (event) => { if (event.pointerId === drag?.pointerId) cancel(); });
    document.addEventListener('lostpointercapture', (event) => { if (event.pointerId === drag?.pointerId) cancel(); });
    document.addEventListener('keydown', (event) => { if (drag && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } }, true);
    window.addEventListener('blur', () => cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
    narrow.addEventListener('change', () => cancel());
    scroller.addEventListener('scroll', () => { if (drag?.active) updatePreview(); }, { passive: true });
    return { cancel, isBusy: () => Boolean(drag) };
  })();

  // Loading uses a monotonically increasing request id so stale responses cannot win.
  async function loadContext() {
    cancelTomorrow();
    cancelCreation();
    dragController.cancel();
    const requestId = ++state.requestId;
    const date = state.date;
    const departmentId = state.departmentId;
    state.loading = true;
    state.data = null;
    $('error-panel').hidden = true;
    $('message').hidden = false;
    $('message').textContent = 'Загружаем расписание…';
    $('workspace').hidden = false;
    $('workspace').setAttribute('aria-busy', 'true');
    closeDetails();
    renderNavigation();
    clearView();
    try {
      const cached = contexts.get(contextKey(departmentId, date));
      if (cached) { applyData(cached); return; }
      const response = await mockHttp.load(departmentId, date);
      if (requestId !== state.requestId) return;
      applyData(contexts.get(contextKey(departmentId, date)) || normalize(response.raw, response.statusMapping));
    } catch (error) {
      if (requestId === state.requestId) showError(error);
    }
  }

  function applyData(data) {
    dragController.cancel();
    state.data = data;
    state.date = data.date;
    state.departmentId = data.currentDepartment?.id ?? '';
    state.loading = false;
    contexts.set(contextKey(state.departmentId, state.date), data);
    saveDemo();
    $('workspace').setAttribute('aria-busy', 'false');
    $('workspace').hidden = false;
    $('error-panel').hidden = true;
    $('message').hidden = true;
    renderNavigation(data.departments);
    renderSummary();
    renderCalendar();
    renderQueue();
    $('work-hours').textContent = `${clock(data.config.start)}–${clock(data.config.end)} · обед ${clock(data.config.lunchStart)}–${clock(data.config.lunchEnd)}`;
    $('access-mode').textContent = data.currentDepartment?.permitted ? 'Планирование доступно' : 'Только просмотр';
    $('access-mode').classList.toggle('readonly', !data.currentDepartment?.permitted);
    $('create-event').disabled = !data.currentDepartment?.permitted;
    $('create-event').title = data.currentDepartment?.permitted ? '' : 'В этом подразделении доступен только просмотр.';
  }

  function showError(error) {
    dragController.cancel();
    state.loading = false;
    state.data = null;
    clearView();
    $('workspace').setAttribute('aria-busy', 'false');
    $('workspace').hidden = true;
    $('message').hidden = true;
    $('error-text').textContent = error instanceof Error ? error.message : 'Неизвестная ошибка данных.';
    $('error-panel').hidden = false;
    closeQueue();
  }

  function clearView() {
    $('create-event').disabled = true;
    $('calendar').replaceChildren(el('p', 'calendar-empty', 'Загрузка расписания…'));
    $('queue-list').replaceChildren();
    $('summary').replaceChildren();
    $('queue-count').textContent = '—';
    $('mobile-count').textContent = '—';
    $('work-hours').textContent = '';
    $('access-mode').textContent = '';
  }

  function updateData(value) {
    cancelCreation();
    ++state.requestId;
    closeDetails();
    try { applyData(normalize(value)); return true; }
    catch (error) { showError(error); return false; }
  }

  function updateList(key, value) {
    if (!state.data || state.loading) return false;
    try {
      const previous = state.data;
      const statuses = new Map(previous.tasks.map((task) => [task.id, task.status]));
      const payload = decode(value);
      let items = payload;
      if (payload !== null && !Array.isArray(payload)) {
        const wrapper = object(payload, key);
        if (!Object.hasOwn(wrapper, key)) throw new Error(`В обновлении отсутствует список ${key}.`);
        items = wrapper[key];
      }
      if (items === undefined) throw new Error(`Не передан список ${key}.`);
      const projected = { ...previous.raw, events: [], new_events: [] };
      previous.tasks.forEach((task) => {
        const source = structuredClone(task.source);
        if (task.assignment) {
          source.engineer = previous.engineers.find((engineer) => engineer.id === task.assignment.engineerId);
          source.begin = timeValue(originalPlan(task).begin); source.end = timeValue(originalPlan(task).end);
          projected.events.push(source);
        } else projected.new_events.push(source);
      });
      const next = normalize({ ...projected, [key]: items }, statuses);
      next.tasks = next.tasks.map((task) => {
        const old = previous.tasks.find((item) => item.id === task.id);
        const samePlan = old && JSON.stringify(task.assignment) === JSON.stringify(originalPlan(old)) && task.source.duration === old.source.duration;
        return samePlan ? { ...task, ...taskState(old) } : task;
      });
      applyData(next);
      closeDetails();
      return true;
    } catch (error) {
      $('message').textContent = `Обновление не применено. ${error.message}`;
      $('message').hidden = false;
      return false;
    }
  }

  window.UpdateData = updateData;
  window.UpdateEvents = (value) => updateList('events', value);
  window.UpdateNewEvents = (value) => updateList('new_events', value);

  // Rendering uses text nodes for all incoming values.
  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = String(text);
    return node;
  }

  function renderNavigation(departments = state.data?.departments ?? DEPARTMENTS) {
    $('selected-date').value = state.date;
    $('previous-day').disabled = state.date <= '2000-01-01';
    $('next-day').disabled = state.date >= '2099-12-31';
    $('department').replaceChildren(...departments.map((department) => {
      const option = el('option', '', department.name);
      option.value = department.id;
      option.selected = department.id === state.departmentId;
      return option;
    }));
    $('department').disabled = departments.length === 0;
    const weekday = dateObject(state.date).getDay();
    const monday = addDays(state.date, -(weekday === 0 ? 6 : weekday - 1));
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(monday, i);
      const button = el('button', date === localDate(now()) ? 'today' : '');
      button.type = 'button';
      button.setAttribute('aria-label', dateObject(date).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }));
      if (date === state.date) button.setAttribute('aria-current', 'date');
      button.disabled = date < '2000-01-01' || date > '2099-12-31';
      button.append(el('span', '', ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'][i]), el('strong', '', date.slice(8)));
      button.addEventListener('click', () => selectDate(date));
      return button;
    });
    $('week').replaceChildren(...days);
    $('day-caption').textContent = dateObject(state.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' });
  }

  function renderSummary() {
    const scheduled = state.data.tasks.filter((task) => task.assignment);
    const count = (type) => scheduled.filter((task) => task.source.work_type === type).length;
    const values = [
      ['▦', scheduled.length, 'событий запланировано'],
      ['↗', count('ТО'), 'техническое обслуживание'],
      ['⌁', count('Ремонт'), 'ремонт оборудования'],
      ['◎', count('Диагностика'), 'диагностика'],
    ];
    $('summary').replaceChildren(...values.map(([symbol, value, label]) => {
      const card = el('div', 'stat');
      const icon = el('span', 'stat-symbol', symbol);
      icon.setAttribute('aria-hidden', 'true');
      const content = el('div');
      content.append(el('p', 'stat-value', value), el('p', 'stat-label', label));
      card.append(icon, content);
      return card;
    }));
  }

  function markDraggable(card, task) {
    if (state.data.currentDepartment?.permitted && task.status !== 'completed') {
      card.dataset.draggable = 'true';
      card.setAttribute('aria-describedby', 'drag-instructions');
    }
  }

  function workClass(task) {
    if (!task.source.work_type || task.source.is_manual) return 'manual';
    if (/ремонт/i.test(task.source.work_type)) return 'repair';
    if (/диагностика/i.test(task.source.work_type)) return 'diagnostics';
    return 'maintenance';
  }
  function workTitle(task) { return task.source.manual_type || task.source.work_type || 'Событие'; }
  function modelTitle(task) { return task.source.model?.name || task.source.description || 'Без модели оборудования'; }
  function clientTitle(task) { return task.source.client?.client_name || task.source.client?.name || ''; }

  function percent(minutes) {
    const { start, end } = state.data.config;
    return (minutes - start) / (end - start) * 100;
  }

  function addLunch(timeline, header = false) {
    const { lunchStart, lunchEnd } = state.data.config;
    const lunch = el('div', 'lunch', header ? 'Обед' : '');
    lunch.style.left = `${percent(lunchStart)}%`;
    lunch.style.width = `${percent(lunchEnd) - percent(lunchStart)}%`;
    lunch.title = `Обед ${clock(lunchStart)}–${clock(lunchEnd)}`;
    if (!header) lunch.setAttribute('aria-hidden', 'true');
    timeline.append(lunch);
  }

  function renderCalendar() {
    const data = state.data;
    const calendar = $('calendar');
    calendar.replaceChildren();
    calendar.style.setProperty('--hour-width', `${60 / (data.config.end - data.config.start) * 100}%`);
    const header = el('div', 'calendar-row calendar-header');
    const corner = el('div', 'engineer-cell');
    corner.append(el('span', '', 'Специалист'), el('span', '', data.engineers.length));
    const axis = el('div', 'timeline time-axis');
    for (let time = data.config.start; time <= data.config.end; time += 60) {
      const label = el('span', `hour-label${time === data.config.end ? ' end-label' : ''}`, clock(time));
      label.style.left = `${percent(time)}%`;
      axis.append(label);
    }
    if ((data.config.end - data.config.start) % 60 !== 0) {
      const label = el('span', 'hour-label end-label', clock(data.config.end));
      label.style.left = '100%';
      axis.append(label);
    }
    addLunch(axis, true);
    header.append(corner, axis);
    calendar.append(header);
    if (!data.engineers.length) { calendar.append(el('p', 'calendar-empty', 'На этот день нет специалистов.')); return; }
    for (const engineer of data.engineers) {
      const absence = data.absences.find((item) => item.id_engineer.id === engineer.id && item.begin <= data.date && item.end >= data.date);
      const tasks = data.tasks.filter((task) => task.assignment?.engineerId === engineer.id);
      const row = el('div', `calendar-row${absence ? ' absence-row' : ''}`);
      const cell = el('div', 'engineer-cell');
      const avatar = el('span', 'avatar', engineer.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join(''));
      avatar.setAttribute('aria-hidden', 'true');
      const info = el('div', 'engineer-info');
      const name = el('p', 'engineer-name', engineer.name);
      name.title = engineer.name; info.append(name);
      const total = tasks.reduce((sum, task) => sum + occupiedDuration(task), 0);
      const available = data.config.end - data.config.start - (data.config.lunchEnd - data.config.lunchStart);
      const load = Math.round(total / available * 100);
      if (absence) info.append(el('p', 'absence-note', `${absence.type || 'Отсутствует'}${tasks.length ? ' · есть задачи' : ''}`));
      else {
        info.append(el('p', 'engineer-load', `${durationLabel(total)} · ${load}%`));
        const track = el('div', 'load-track');
        track.setAttribute('aria-hidden', 'true');
        const fill = el('span'); fill.style.width = `${Math.min(100, load)}%`; track.append(fill); info.append(track);
      }
      cell.append(avatar, info);
      const timeline = el('div', 'timeline');
      timeline.dataset.engineerId = engineer.id;
      addLunch(timeline);
      for (const task of tasks) {
        const card = el('button', `calendar-event ${workClass(task)}`);
        card.type = 'button';
        card.dataset.taskId = task.id;
        markDraggable(card, task);
        const label = `${workTitle(task)} · ${task.source.model?.name || task.source.description || 'Событие'}`;
        const times = `${clock(task.assignment.begin)}–${clock(task.assignment.end)}`;
        card.setAttribute('aria-label', `${label}. ${engineer.name}. ${times}. ${STATUS[task.status]}${timeNotice(task) ? '. ' + timeNotice(task) : ''}`);
        card.style.left = `calc(${percent(task.assignment.begin)}% + 3px)`;
        card.style.width = `calc(${percent(task.assignment.end) - percent(task.assignment.begin)}% - 6px)`;
        card.append(el('span', 'event-title', label), el('span', 'event-time', `${times} · ${durationLabel(occupiedDuration(task))}`), el('span', 'event-status', `${task.status === 'completed' ? '✓ ' : task.status === 'in_progress' ? '● ' : ''}${STATUS[task.status]}${task.isEscalation ? ' · Эскалация' : ''}${timeNotice(task) ? ' · ' + timeNotice(task) : ''}`));
        card.addEventListener('click', () => showDetails(task.id, card));
        timeline.append(card);
      }
      if (absence && !tasks.length) timeline.append(el('span', 'absence-overlay', 'Специалист отсутствует'));
      row.append(cell, timeline); calendar.append(row);
    }
    if (!data.tasks.some((task) => task.assignment)) calendar.append(el('p', 'calendar-empty', 'На этот день события не запланированы.'));
  }

  function renderQueue() {
    if (!state.data) return;
    queueRefreshPending = false; $('ws-pending').hidden = true;
    const unassigned = state.data.tasks.filter((task) => !task.assignment);
    $('queue-count').textContent = unassigned.length;
    $('mobile-count').textContent = unassigned.length;
    const query = state.query.toLocaleLowerCase('ru').trim();
    const filtered = unassigned.filter((task) => [workTitle(task), modelTitle(task), clientTitle(task), task.source.description, STATUS[task.status], task.isEscalation ? 'эскалация' : '', task.source.priority ? 'срочно' : ''].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(query));
    const compare = (a, b) => state.sort === 'duration-desc' ? b.source.duration - a.source.duration : state.sort === 'duration-asc' ? a.source.duration - b.source.duration : Number(b.source.priority === true) - Number(a.source.priority === true);
    const groups = [
      ['К распределению', '', filtered.filter((task) => !task.isEscalation && !task.source.is_manual)],
      ['Эскалация', 'escalation', filtered.filter((task) => task.isEscalation && !task.source.is_manual)],
      ['Ручные события', '', filtered.filter((task) => task.source.is_manual)],
    ];
    const list = $('queue-list');
    list.replaceChildren();
    if (!filtered.length) {
      const empty = el('div', 'empty-queue');
      empty.append(el('p', '', query ? 'Ничего не найдено. Попробуйте другое название.' : 'Все обращения распределены.'));
      if (query) {
        const reset = el('button', 'quiet-button', 'Сбросить поиск');
        reset.addEventListener('click', () => { $('search').value = ''; state.query = ''; renderQueue(); $('search').focus(); });
        empty.append(reset);
      }
      list.append(empty); return;
    }
    for (const [title, className, tasks] of groups) {
      if (!tasks.length) continue;
      const group = el('section', `queue-group ${className}`);
      const heading = el('h3'); heading.append(el('span', '', title), el('span', '', tasks.length)); group.append(heading);
      for (const task of tasks.sort(compare)) {
        const card = el('button', `queue-card${task.isEscalation ? ' escalated' : ''}`);
        card.type = 'button'; card.dataset.taskId = task.id;
        markDraggable(card, task);
        const top = el('span', 'queue-card-top');
        top.append(el('span', `work-tag ${workClass(task)}`, workTitle(task)), el('span', 'duration', durationLabel(occupiedDuration(task))));
        card.append(top, el('strong', '', task.source.is_manual ? task.source.manual_type || 'Событие' : modelTitle(task)));
        card.append(el('span', 'queue-client', task.source.is_manual ? task.source.description || 'Без описания' : clientTitle(task) || 'Заказчик не указан'));
        const bottom = el('span', 'queue-card-bottom');
        bottom.append(el('span', '', STATUS[task.status]));
        if (task.source.priority === true) bottom.append(el('span', 'urgent', '● Срочно'));
        if (task.isEscalation) bottom.append(el('span', 'urgent', '↑ Эскалация'));
        card.append(bottom); card.addEventListener('click', () => showDetails(task.id, card)); group.append(card);
      }
      list.append(group);
    }
  }

  function showDetails(id, opener) {
    const task = state.data?.tasks.find((item) => item.id === id);
    if (!task) return;
    returnFocus = opener;
    activeTaskId = id;
    $('details-title').textContent = task.source.is_manual ? workTitle(task) : task.source.model?.name || workTitle(task);
    const content = $('details-content'); content.replaceChildren();
    const statuses = el('div', 'detail-status'); statuses.append(el('span', 'badge', STATUS[task.status]));
    const timing = el('span', 'badge urgent', timeNotice(task)); timing.id = 'detail-timing'; timing.hidden = !timeNotice(task); statuses.append(timing);
    if (task.isEscalation) statuses.append(el('span', 'badge urgent', 'Эскалация'));
    if (task.source.priority) statuses.append(el('span', 'badge urgent', 'Срочно'));
    const list = el('dl', 'detail-list');
    const add = (name, value) => { if (value != null && value !== '') list.append(el('dt', '', name), el('dd', '', value)); };
    add('Вид работ', workTitle(task)); add('Оборудование', task.source.model?.name); add('Заказчик', clientTitle(task)); add('Адрес', task.source.client?.client_address);
    add('Дата', dateObject(task.date).toLocaleDateString('ru-RU')); add('Длительность', durationLabel(occupiedDuration(task)));
    if (task.assignment) {
      add('Специалист', state.data.engineers.find((engineer) => engineer.id === task.assignment.engineerId)?.name);
      add('Время', `${clock(task.assignment.begin)}–${clock(task.assignment.end)}`);
      const absence = state.data.absences.find((item) => item.id_engineer.id === task.assignment.engineerId && item.begin <= task.date && item.end >= task.date);
      if (absence) add('Внимание', `${absence.type || 'Отсутствие'} — назначение требует переноса.`);
    } else add('Назначение', 'Специалист и время не выбраны');
    add('Компетенции', task.backups === null ? 'Любой специалист' : task.backups.length ? task.backups.map((engineer) => `${engineer.name}${Number.isFinite(engineer.scoring_points) ? ` · ${engineer.scoring_points} баллов` : ''}`).join('; ') : 'Нет подходящих специалистов');
    const extra = el('details', 'detail-extra');
    extra.append(el('summary', '', 'Данные обращения и компетенции'), list);
    if (task.source.description) extra.append(el('p', 'detail-description', task.source.description));
    const assignmentSummary = task.assignment ? `${state.data.engineers.find((engineer) => engineer.id === task.assignment.engineerId)?.name} · ${clock(task.assignment.begin)}–${clock(task.assignment.end)}` : 'Специалист и время не выбраны';
    content.append(statuses, el('p', 'detail-summary', `${workTitle(task)} · ${durationLabel(occupiedDuration(task))} · ${dateObject(task.date).toLocaleDateString('ru-RU')}`), el('p', 'detail-summary', assignmentSummary), extra);
    renderStatusDetails(task, content);
    renderStatusForm(task);
    renderAssignmentForm(task);
    $('details-dialog').showModal(); $('close-details').focus();
  }

  function renderStatusDetails(task, content) {
    const facts = el('dl', 'detail-list status-facts');
    const add = (label, value) => facts.append(el('dt', '', label), el('dd', '', value));
    if (task.plannedAssignment) add('Исходный план', `${clock(task.plannedAssignment.begin)}–${clock(task.plannedAssignment.end)} · ${durationLabel(task.source.duration)}`);
    if (task.actualStartedAt) add('Начало по факту', formatFact(task.actualStartedAt));
    if (task.actualCompletedAt) {
      add('Завершение', formatFact(task.actualCompletedAt));
      const delta = Math.round((new Date(task.actualCompletedAt) - scheduledAt(task, task.plannedAssignment.end)) / 60000);
      add('Результат', delta < 0 ? `Досрочно на ${durationLabel(-delta)}. Занятость сокращена до фактического завершения.` : delta > 0 ? `Позже плана на ${durationLabel(delta)}. Плановый слот не расширен.` : 'В плановое время.');
    }
    if (facts.childNodes.length) content.append(facts);
    if (task.history.length) {
      const history = el('details', 'detail-extra'); history.append(el('summary', '', `История действий · ${task.history.length}`));
      const list = el('ol', 'history-list');
      const names = { NewPlanning: 'Назначено', MoveEvent: 'Назначение изменено', ReturnToQueue: 'Возвращено в очередь', StartWork: 'Работа начата', Defer: 'Отложено', Complete: 'Выполнено', MoveToTomorrow: 'Перенесено на следующий день' };
      for (const entry of task.history) {
        const prior = entry.before?.assignment;
        const details = prior ? ` · было: ${state.data.engineers.find((engineer) => engineer.id === prior.engineerId)?.name || 'Специалист'} ${clock(prior.begin)}–${clock(prior.end)}` : '';
        list.append(el('li', '', `${formatFact(entry.at)} · ${names[entry.action] || 'Изменение'}${entry.before?.date ? ' · ' + entry.before.date + ' → ' + entry.after.date : ''}${details}${entry.before?.actualStartedAt ? ' · начало по факту: ' + formatFact(entry.before.actualStartedAt) : ''}`));
      }
      history.append(list); content.append(history);
    }
  }
  function renderStatusForm(task) {
    $('status-error').hidden = true;
    const date = minuteNow();
    $('completion-time').value = `${localDate(date)}T${clock(date.getHours() * 60 + date.getMinutes())}`;
    updateStatusAvailability(task);
  }
  function updateStatusAvailability(task) {
    if (tomorrowTransfer) return;
    const editable = state.data?.currentDepartment?.permitted && task.assignment && task.status !== 'completed';
    $('status-form').hidden = !editable;
    if (!editable) return;
    $('status-clock').textContent = `${demoNow ? 'Демо-часы' : 'Текущее время'}: ${formatFact(now().toISOString())}. Статус меняется только вашим действием.`;
    const start = validateStatus(task, 'StartWork');
    $('start-work').hidden = task.status !== 'planned';
    $('start-work').disabled = !start.ok;
    $('start-reason').textContent = task.status === 'planned' && !start.ok ? start.message : '';
    $('completion-time').max = `${localDate(now())}T${clock(now().getHours() * 60 + now().getMinutes())}`;
  }

  function renderAssignmentForm(task) {
    const editable = state.data.currentDepartment?.permitted && task.status !== 'completed';
    $('assignment-form').hidden = !editable;
    $('assignment-readonly').hidden = editable;
    $('assignment-readonly').textContent = task.status === 'completed' ? 'Обращение завершено. Изменение назначения недоступно.' : 'В этом подразделении доступен только просмотр.';
    clearAssignmentError();
    if (!editable) return;
    $('assignment-title').textContent = task.assignment ? 'Изменить назначение' : 'Назначить специалиста';
    $('assign-task').textContent = task.assignment ? 'Сохранить назначение' : 'Назначить';
    $('unassign-task').hidden = !task.assignment;
    const placeholder = el('option', '', 'Выберите специалиста'); placeholder.value = '';
    $('assignment-engineer').replaceChildren(placeholder, ...state.data.engineers.map((engineer) => {
      const option = el('option', '', engineer.name); option.value = engineer.id; return option;
    }));
    $('assignment-engineer').value = task.assignment?.engineerId ?? '';
    $('assignment-time').value = task.assignment ? clock(task.assignment.begin) : '';
    const { start, end, lunchStart, lunchEnd } = state.data.config;
    $('assignment-rules').textContent = `Рабочий день ${clock(start)}–${clock(end)}, обед ${clock(lunchStart)}–${clock(lunchEnd)}. Шаг ${CONFIG.slotStepMinutes} мин; между событиями — ${CONFIG.minGapMinutes} мин.`;
    updateAssignmentPreview();
  }
  function formBegin() {
    const value = $('assignment-time').value;
    if (!/^\d{2}:\d{2}$/.test(value)) return NaN;
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  }
  function clearAssignmentError() {
    $('assignment-error').hidden = true;
    for (const id of ['assignment-engineer', 'assignment-time']) $(id).removeAttribute('aria-invalid');
  }
  function updateAssignmentPreview() {
    clearAssignmentError();
    const task = state.data?.tasks.find((item) => item.id === activeTaskId);
    if (!task) return;
    const engineerId = $('assignment-engineer').value;
    const eligible = task.backups?.find((item) => item.id === engineerId);
    $('assignment-score').textContent = !engineerId ? 'Выберите специалиста, чтобы увидеть компетенцию.' : task.backups === null ? 'Ограничений по компетенции нет.' : !eligible ? 'У выбранного специалиста нет необходимой компетенции.' : Number.isFinite(eligible.scoring_points) ? `Компетенция: ${eligible.scoring_points} баллов.` : 'Компетенция подтверждена, скоринг не указан.';
    const begin = formBegin();
    $('assignment-preview').textContent = Number.isFinite(begin) && begin + task.source.duration < 1440 ? `${clock(begin)}–${clock(begin + task.source.duration)} · ${durationLabel(occupiedDuration(task))}` : 'Укажите время начала.';
  }
  function showAssignmentError(result) {
    $('assignment-error').textContent = result.message;
    $('assignment-error').hidden = false;
    const field = $(result.field || 'assignment-time');
    field.setAttribute('aria-invalid', 'true'); field.focus();
  }
  function finishPlanning(id, message) {
    // Closing the mobile drawer reveals the destination and avoids focusing a removed card.
    closeQueue();
    returnFocus = [...document.querySelectorAll('[data-task-id]')].find((node) => node.dataset.taskId === id) || $('schedule-title');
    if (returnFocus.classList.contains('queue-card') && matchMedia('(max-width: 1100px)').matches) returnFocus = $('open-queue');
    closeDetails();
    $('message').textContent = message; $('message').hidden = false;
  }
  function submitAssignment(event) {
    event.preventDefault();
    const task = state.data?.tasks.find((item) => item.id === activeTaskId);
    if (!task) { showAssignmentError({ message: 'Обращение больше не доступно. Откройте карточку заново.' }); return; }
    const action = task.assignment ? planningActions.MoveEvent : planningActions.NewPlanning;
    const result = action(task.id, $('assignment-engineer').value, formBegin());
    if (!result.ok) { showAssignmentError(result); return; }
    finishPlanning(task.id, task.assignment ? 'Назначение изменено.' : 'Обращение назначено специалисту.');
  }
  function resetDemo() {
    clearTimeout(wsTimer); wsTimer = null; ++wsTimerVersion; ++wsResetVersion;
    wsSettings = { intervalMs: CONFIG.mockWsIntervalMs, maxMessages: CONFIG.mockWsMaxMessages, paused: false, generated: 0 };
    wsReceipts = new Set(); wsNotice = ''; queueRefreshPending = false;
    $('ws-error').hidden = true; syncWsInputs();
    cancelCreation();
    storageBlocked = false; storageNotice = '';
    try { storage.remove(); }
    catch (error) { storageBlocked = true; storageNotice = 'Демо сброшено только в памяти. Хранилище недоступно: прежние данные могут вернуться после перезагрузки.'; }
    contexts.clear();
    state.date = localDate(now()); state.departmentId = 'medical'; state.query = ''; state.sort = 'priority';
    $('search').value = ''; $('sort').value = 'priority';
    closeDetails(); closeQueue(); renderStorageStatus(); loadContext(); restartWsTimer();
  }

  // Creation keeps a cancellable request and commits into its captured context.
  function validateManualInput(input) {
    const errors = {};
    if (!MANUAL_TYPES.includes(input.type)) errors['create-type'] = 'Выберите тип события из списка.';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!description) errors['create-description'] = 'Опишите событие.';
    if (!Number.isSafeInteger(input.duration) || input.duration <= 0) errors['create-duration'] = 'Укажите положительное целое число минут.';
    return { ok: Object.keys(errors).length === 0, errors, value: { type: input.type, description, duration: input.duration } };
  }
  function clearCreationErrors() {
    for (const id of ['create-type', 'create-description', 'create-duration']) {
      $(id).removeAttribute('aria-invalid'); $(`${id}-error`).textContent = ''; $(`${id}-error`).hidden = true;
    }
    $('create-error').hidden = true;
  }
  function setCreating(pending) {
    $('create-fields').disabled = pending;
    $('save-event').disabled = pending;
    $('save-event').textContent = pending ? 'Создаём…' : 'Создать событие';
    $('create-event-form').setAttribute('aria-busy', String(pending));
    $('create-progress').textContent = pending ? 'Создаём событие. Можно отменить.' : '';
  }
  function openCreation() {
    if (state.loading || !state.data?.currentDepartment?.permitted || $('create-dialog').open) return;
    creation = { key: contextKey(state.departmentId, state.date), departmentId: state.departmentId, date: state.date, pending: false, controller: null };
    creationReturnFocus = $('create-event');
    $('create-event-form').reset(); clearCreationErrors(); setCreating(false);
    $('create-type').replaceChildren(...MANUAL_TYPES.map((type) => { const option = el('option', '', type); option.value = type; return option; }));
    $('create-context').textContent = `${dateObject(state.date).toLocaleDateString('ru-RU')} · ${state.data.currentDepartment.name}`;
    $('create-dialog').showModal(); $('create-description').focus();
  }
  function cancelCreation() {
    creation?.controller?.abort(); creation = null;
    setCreating(false);
    if ($('create-dialog').open) $('create-dialog').close();
  }
  async function submitCreation(event) {
    event.preventDefault();
    const session = creation;
    if (!session || session.pending) return;
    clearCreationErrors();
    const input = { type: $('create-type').value, description: $('create-description').value, duration: Number($('create-duration').value) };
    const validation = validateManualInput(input);
    if (!validation.ok) {
      for (const [id, message] of Object.entries(validation.errors)) { $(id).setAttribute('aria-invalid', 'true'); $(`${id}-error`).textContent = message; $(`${id}-error`).hidden = false; }
      $(Object.keys(validation.errors)[0]).focus(); return;
    }
    if (!contexts.get(session.key)?.currentDepartment?.permitted) { $('create-error').textContent = 'В этом подразделении создание событий недоступно.'; $('create-error').hidden = false; return; }
    session.pending = true; session.controller = new AbortController(); setCreating(true);
    try {
      const source = await mockHttp.NewUserEvent(session, validation.value, session.controller.signal);
      if (creation !== session || session.controller.signal.aborted) return;
      const latest = contexts.get(session.key);
      if (!latest?.currentDepartment?.permitted) throw new Error('Расписание изменилось: создание события недоступно.');
      if ([...contexts.values()].some((data) => data.tasks.some((task) => task.id === source.id))) throw new Error('Получен повторный идентификатор события. Повторите создание.');
      const task = normalize({ ...latest.raw, events: [], new_events: [source] }).tasks[0];
      const next = { ...latest, raw: { ...latest.raw, new_events: [...array(latest.raw.new_events, 'очередь'), source] }, tasks: [...latest.tasks, task] };
      const isCurrent = state.data && contextKey(state.departmentId, state.date) === session.key;
      creation = null;
      if (isCurrent) {
        state.query = ''; $('search').value = '';
        applyData(next);
        creationReturnFocus = [...$('queue-list').querySelectorAll('[data-task-id]')].find((node) => node.dataset.taskId === source.id) || $('create-event');
      } else { contexts.set(session.key, next); saveDemo(); }
      setCreating(false); $('create-dialog').close();
      $('message').textContent = `Событие «${source.manual_type}» создано и добавлено в очередь на ${dateObject(session.date).toLocaleDateString('ru-RU')}.`;
      $('message').hidden = false;
    } catch (error) {
      if (creation !== session || session.controller.signal.aborted) return;
      $('create-error').textContent = error instanceof Error ? error.message : 'Не удалось создать событие.';
      $('create-error').hidden = false;
    } finally {
      if (creation === session) { session.pending = false; setCreating(false); }
    }
  }

  function closeDetails() { cancelTomorrow(); if ($('details-dialog').open) $('details-dialog').close(); }

  function selectDate(date) {
    try { state.date = parseDate(date); loadContext(); }
    catch (error) { $('selected-date').value = state.date; $('message').textContent = error.message; $('message').hidden = false; }
  }

  function openQueue() {
    $('queue-panel').classList.add('is-open');
    $('queue-backdrop').hidden = false;
    $('queue-panel').setAttribute('role', 'dialog'); $('queue-panel').setAttribute('aria-modal', 'true');
    $('open-queue').setAttribute('aria-expanded', 'true');
    document.querySelectorAll('main > :not(.workspace), .topbar, .schedule-panel').forEach((node) => { node.inert = true; });
    $('close-queue').focus();
  }

  function closeQueue() {
    const wasOpen = $('queue-panel').classList.contains('is-open');
    $('queue-panel').classList.remove('is-open'); $('queue-backdrop').hidden = true;
    $('queue-panel').removeAttribute('role'); $('queue-panel').removeAttribute('aria-modal');
    $('open-queue').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('[inert]').forEach((node) => { node.inert = false; });
    if (wasOpen && matchMedia('(max-width: 1100px)').matches) $('open-queue').focus();
  }

  function trapDialogFocus(event) {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget;
    const controls = [...dialog.querySelectorAll('button, input, textarea, select, summary, [href], [tabindex]')].filter((node) => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const first = controls[0]; const last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  for (const id of ['details-dialog', 'reset-dialog', 'create-dialog']) $(id).addEventListener('keydown', trapDialogFocus);

  $('ws-settings').addEventListener('submit', saveWsSettings);
  $('ws-toggle').addEventListener('click', () => { wsSettings.paused = !wsSettings.paused; saveDemo(); restartWsTimer(); });
  document.addEventListener('focusout', () => { if (queueRefreshPending) setTimeout(flushQueueRefresh, 0); });
  for (const id of ['details-dialog', 'create-dialog', 'reset-dialog']) $(id).addEventListener('close', () => queueMicrotask(flushQueueRefresh));
  if (storageMode === 'memory') {
    $('ws-probe').hidden = false;
    $('ws-probe-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const result = await receiveWsMessage($('ws-probe-payload').value);
      $('ws-probe-result').textContent = result.accepted ? 'Принято' : result.duplicate ? 'Повтор пропущен' : result.cancelled ? 'Отменено' : 'Отклонено';
    });
  }
  $('create-event').addEventListener('click', openCreation);
  $('create-event-form').addEventListener('submit', submitCreation);
  $('close-create').addEventListener('click', cancelCreation);
  $('cancel-create').addEventListener('click', cancelCreation);
  $('create-dialog').addEventListener('cancel', (event) => { event.preventDefault(); cancelCreation(); });
  $('create-dialog').addEventListener('close', () => {
    cancelCreation();
    if (creationReturnFocus?.isConnected && !creationReturnFocus.disabled) creationReturnFocus.focus();
    creationReturnFocus = null;
  });

  $('selected-date').addEventListener('change', (event) => selectDate(event.target.value));
  $('previous-day').addEventListener('click', () => selectDate(addDays(state.date, -1)));
  $('next-day').addEventListener('click', () => selectDate(addDays(state.date, 1)));
  $('today').addEventListener('click', () => selectDate(localDate(now())));
  $('department').addEventListener('change', (event) => { state.departmentId = event.target.value; loadContext(); });
  $('search').addEventListener('input', (event) => { state.query = event.target.value; renderQueue(); });
  $('sort').addEventListener('change', (event) => { state.sort = event.target.value; renderQueue(); });
  $('retry').addEventListener('click', loadContext);
  $('close-details').addEventListener('click', closeDetails);
  $('details-dialog').addEventListener('cancel', cancelTomorrow);
  $('details-dialog').addEventListener('close', () => { cancelTomorrow(); if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null; activeTaskId = null; });
  $('assignment-form').addEventListener('submit', submitAssignment);
  $('status-form').addEventListener('submit', (event) => { event.preventDefault(); commitStatus('Complete'); });
  $('start-work').addEventListener('click', () => commitStatus('StartWork'));
  $('defer-task').addEventListener('click', () => commitStatus('Defer'));
  $('move-tomorrow').addEventListener('click', moveToTomorrow);
  $('completion-time').addEventListener('input', () => { $('status-error').hidden = true; });
  $('assignment-engineer').addEventListener('change', updateAssignmentPreview);
  $('assignment-time').addEventListener('input', updateAssignmentPreview);
  $('unassign-task').addEventListener('click', () => {
    const id = activeTaskId;
    const result = planningActions.ReturnToQueue(id);
    if (!result.ok) { showAssignmentError(result); return; }
    finishPlanning(id, 'Обращение возвращено в очередь. Статус: «Открыта».');
  });
  $('reset-demo').addEventListener('click', () => { $('reset-dialog').returnValue = ''; $('reset-dialog').showModal(); $('cancel-reset').focus(); });
  $('reset-dialog').addEventListener('close', () => { if ($('reset-dialog').returnValue === 'confirm') resetDemo(); $('reset-demo').focus(); });
  $('open-queue').addEventListener('click', openQueue);
  $('close-queue').addEventListener('click', closeQueue);
  $('queue-backdrop').addEventListener('click', closeQueue);
  document.addEventListener('keydown', (event) => {
    if (!$('queue-panel').classList.contains('is-open') || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeQueue(); }
    if (event.key === 'Tab') {
      const focusable = [...$('queue-panel').querySelectorAll('button, input, select')].filter((node) => !node.disabled && node.getClientRects().length);
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  matchMedia('(max-width: 1100px)').addEventListener('change', (event) => { if (!event.matches) closeQueue(); });
  if (demoNow) {
    $('clock-notice').hidden = false;
    $('clock-notice').textContent = `Демо-часы зафиксированы: ${formatFact(demoNow.toISOString())}`;
  }
  // Refresh only time-derived text; keep focus, form input, and any active drag intact.
  setInterval(() => {
    if (!state.data || state.loading) return;
    for (const card of document.querySelectorAll('.calendar-event')) {
      const task = state.data.tasks.find((item) => item.id === card.dataset.taskId);
      if (!task) continue;
      const notice = timeNotice(task);
      card.querySelector('.event-status').textContent = `${task.status === 'completed' ? '✓ ' : task.status === 'in_progress' ? '● ' : ''}${STATUS[task.status]}${task.isEscalation ? ' · Эскалация' : ''}${notice ? ' · ' + notice : ''}`;
      const engineer = state.data.engineers.find((item) => item.id === task.assignment.engineerId);
      card.setAttribute('aria-label', `${workTitle(task)} · ${modelTitle(task)}. ${engineer?.name}. ${clock(task.assignment.begin)}–${clock(task.assignment.end)}. ${STATUS[task.status]}${notice ? '. ' + notice : ''}`);
    }
    const active = state.data.tasks.find((task) => task.id === activeTaskId);
    if (active && $('details-dialog').open) {
      updateStatusAvailability(active);
      $('detail-timing').textContent = timeNotice(active); $('detail-timing').hidden = !timeNotice(active);
    }
  }, 30000);
  restoreDemo();
  renderStorageStatus(); syncWsInputs();
  loadContext(); restartWsTimer();
})();
