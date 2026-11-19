import type { Permission } from '../../config/permissions';

/**
 * What can be imported and how spreadsheet columns are matched to application fields. Matching
 * is deterministic: a column the school mapped before, then an exact name or known alias, then
 * keyword patterns ("Father/Guard Mobile" contains "father" + "mobile" → Parent phone). The user
 * reviews and can change every suggestion before anything is checked or saved.
 */
export const IMPORT_TYPES = ['students', 'parents', 'staff', 'classes', 'timetable', 'staff_punches', 'fees'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export interface FieldDef {
  key: string;
  label: string;
  /** Required on every row (marked * in templates). Conditional rules are explained in `description`. */
  required?: boolean;
  description: string;
  example: string;
  /** Whole-column names (compared after normalisation). */
  aliases: string[];
  /** Keyword sets: a heading containing all words of a set matches; longer sets win. */
  patterns?: string[][];
  /** Shown in the template and its instructions (fields only for mapping set false). */
  inTemplate?: boolean;
  /** Dropdown values for the Excel template. */
  options?: string[];
  /** The template column holds text even if it looks like a number (keeps leading zeros). */
  textColumn?: boolean;
  dateColumn?: boolean;
}

export interface TypeDef {
  type: ImportType;
  label: string;
  description: string;
  permission: Permission;
  /** How existing records are recognised. */
  identifier: string;
  fields: FieldDef[];
  /** Fields where at least one must be mapped (e.g. a full name or a first name). */
  oneOf?: string[][];
  /** Columns commonly found in other systems that have no place here (warned, not silently lost). */
  knownIgnored?: Array<{ patterns: string[][]; reason: string }>;
  /** Extra lines for the template's instructions. */
  guide?: string[];
}

const STUDENT_FIELDS: FieldDef[] = [
  {
    key: 'admissionNo',
    label: 'Admission No',
    description:
      'The student’s admission or registration number. Leave empty to have one generated. Used to recognise students already in the system.',
    example: 'ST-1001',
    aliases: [
      'admission no',
      'admission number',
      'adm no',
      'admission',
      'registration no',
      'registration number',
      'reg no',
      'gr no',
      'gr number',
      'student id',
      'sid',
      'student no',
      'student number',
      'enrollment no',
      'enrolment no',
      'admission #',
      'id',
    ],
    patterns: [['admission', 'no'], ['admission', 'number'], ['registration'], ['enrol'], ['enroll']],
    textColumn: true,
  },
  {
    key: 'fullName',
    label: 'Student Name',
    required: true,
    description: 'Full name of the student. (Instead, you can map separate First name and Last name columns.)',
    example: 'Ali Ahmed',
    aliases: [
      'student name',
      'name',
      'full name',
      'student full name',
      'name of student',
      'pupil name',
      'child name',
      'student',
    ],
    patterns: [
      ['student', 'name'],
      ['pupil', 'name'],
      ['child', 'name'],
    ],
  },
  {
    key: 'firstName',
    label: 'First name',
    description: 'Student’s first name (use with Last name).',
    example: 'Ali',
    aliases: ['first name', 'given name', 'student first name', 'fname'],
    patterns: [['first', 'name']],
    inTemplate: false,
  },
  {
    key: 'lastName',
    label: 'Last name',
    description: 'Student’s last name.',
    example: 'Ahmed',
    aliases: ['last name', 'surname', 'family name', 'lname'],
    patterns: [['last', 'name'], ['surname']],
    inTemplate: false,
  },
  {
    key: 'gender',
    label: 'Gender',
    required: true,
    description: 'Male, Female or Other (M/F also accepted).',
    example: 'Male',
    aliases: ['gender', 'sex'],
    patterns: [['gender'], ['sex']],
    options: ['Male', 'Female', 'Other'],
  },
  {
    key: 'dateOfBirth',
    label: 'Date of Birth',
    description: 'YYYY-MM-DD is best. 12/03/2015 is read as 12 March 2015 (day first); 12-Mar-2015 also works.',
    example: '2015-03-12',
    aliases: ['dob', 'date of birth', 'birth date', 'd o b', 'birthday', 'birthdate'],
    patterns: [
      ['birth', 'date'],
      ['date', 'birth'],
    ],
    dateColumn: true,
  },
  {
    key: 'className',
    label: 'Class',
    required: true,
    description: 'Exactly as the class is named in the system (Academics → Classes), e.g. Class 5 or PG.',
    example: 'Class 5',
    aliases: ['class', 'grade', 'standard', 'class name', 'grade name', 'current class', 'class grade'],
    patterns: [['class'], ['grade'], ['standard']],
  },
  {
    key: 'sectionName',
    label: 'Section',
    required: true,
    description:
      'Section of that class, e.g. A. If your file has no section, you can choose one section for all rows during the import.',
    example: 'A',
    aliases: ['section', 'group', 'class section', 'section name', 'group name', 'sec'],
    patterns: [['section'], ['group']],
  },
  {
    key: 'sessionName',
    label: 'Session',
    description: 'Academic session name, e.g. 2025-2026. Leave empty for the current session.',
    example: '2025-2026',
    aliases: ['session', 'academic session', 'academic year', 'session year', 'year'],
    patterns: [['session'], ['academic', 'year']],
    textColumn: true,
  },
  {
    key: 'campusName',
    label: 'Campus',
    description: 'Only for schools with more than one campus. Leave empty to choose one campus for all rows.',
    example: 'Main Campus',
    aliases: ['campus', 'branch', 'campus name', 'branch name'],
    patterns: [['campus'], ['branch']],
  },
  {
    key: 'rollNo',
    label: 'Roll No',
    description: 'Roll number in the class.',
    example: '12',
    aliases: ['roll no', 'roll number', 'roll'],
    patterns: [['roll']],
    textColumn: true,
  },
  {
    key: 'bFormNo',
    label: 'B-Form No',
    description: 'NADRA B-Form number (kept private).',
    example: '35201-1234567-1',
    aliases: ['b form', 'b form no', 'bform', 'b form number', 'birth certificate no', 'b form cnic'],
    patterns: [['b', 'form'], ['bform'], ['birth', 'certificate']],
    textColumn: true,
  },
  {
    key: 'bloodGroup',
    label: 'Blood Group',
    description: 'e.g. B+',
    example: 'B+',
    aliases: ['blood group', 'blood'],
    patterns: [['blood']],
    inTemplate: false,
  },
  {
    key: 'parentName',
    label: 'Parent Name',
    description: 'Father’s or guardian’s name. Parent Name and Parent Phone go together: give both or neither.',
    example: 'Ahmed Khan',
    aliases: [
      'parent name',
      'father name',
      'guardian name',
      'father',
      'guardian',
      'parent',
      'father guardian',
      'father guard',
      'father guardian name',
      'parent guardian',
    ],
    patterns: [['father'], ['guardian'], ['parent'], ['guard']],
  },
  {
    key: 'parentRelation',
    label: 'Parent Relation',
    description: 'Father, Mother, Guardian or Other. Default: Father when the column says father, otherwise Guardian.',
    example: 'Father',
    aliases: ['relation', 'relationship', 'parent relation', 'guardian relation', 'relation with student'],
    patterns: [['relation']],
    options: ['Father', 'Mother', 'Guardian', 'Other'],
  },
  {
    key: 'parentPhone',
    label: 'Parent Phone',
    description:
      'Mobile number, e.g. 03001234567. Students with the same parent phone are linked to one parent record (siblings).',
    example: '03001234567',
    aliases: [
      'parent phone',
      'phone',
      'mobile',
      'contact',
      'contact no',
      'contact number',
      'phone no',
      'phone number',
      'mobile no',
      'mobile number',
      'cell',
      'cell no',
      'telephone',
      'father mobile',
      'father phone',
      'guardian phone',
      'guardian mobile',
      'parent mobile',
      'parent contact',
    ],
    patterns: [
      ['father', 'mobile'],
      ['father', 'phone'],
      ['father', 'contact'],
      ['father', 'cell'],
      ['guardian', 'phone'],
      ['guardian', 'mobile'],
      ['guardian', 'contact'],
      ['parent', 'phone'],
      ['parent', 'mobile'],
      ['parent', 'contact'],
      ['guard', 'mobile'],
      ['guard', 'phone'],
      ['guard', 'contact'],
    ],
    textColumn: true,
  },
  {
    key: 'parentCnic',
    label: 'Parent CNIC',
    description: '13 digits, e.g. 35202-1234567-1.',
    example: '35202-1234567-1',
    aliases: ['cnic', 'parent cnic', 'father cnic', 'guardian cnic', 'father nic', 'nic'],
    patterns: [['cnic'], ['nic']],
    textColumn: true,
  },
  {
    key: 'parentEmail',
    label: 'Parent Email',
    description: 'Optional email address of the parent.',
    example: 'ahmed@example.com',
    aliases: ['email', 'parent email', 'father email', 'e mail', 'email address'],
    patterns: [['email'], ['e', 'mail']],
    inTemplate: false,
  },
  {
    key: 'parentOccupation',
    label: 'Parent Occupation',
    description: 'Optional.',
    example: 'Engineer',
    aliases: ['occupation', 'father occupation', 'profession', 'parent occupation'],
    patterns: [['occupation'], ['profession']],
    inTemplate: false,
  },
  {
    key: 'motherName',
    label: 'Mother Name',
    description: 'Adds the mother as a second guardian (give Mother Phone too).',
    example: 'Sana Ahmed',
    aliases: ['mother name', 'mother', 'mother s name', 'mothers name'],
    patterns: [['mother', 'name']],
  },
  {
    key: 'motherPhone',
    label: 'Mother Phone',
    description: 'Mother’s mobile number. Used together with Mother Name.',
    example: '03111234567',
    aliases: ['mother phone', 'mother mobile', 'mother contact', 'mother cell'],
    patterns: [
      ['mother', 'mobile'],
      ['mother', 'phone'],
      ['mother', 'contact'],
      ['mother', 'cell'],
    ],
    textColumn: true,
  },
  {
    key: 'address',
    label: 'Address',
    description: 'Home address.',
    example: 'House 12, Street 4, Lahore',
    aliases: ['address', 'home address', 'residential address', 'postal address'],
    patterns: [['address']],
  },
  {
    key: 'studentPhone',
    label: 'Student Phone',
    description: 'The student’s own number, if any.',
    example: '',
    aliases: ['student phone', 'student mobile', 'student contact'],
    patterns: [
      ['student', 'phone'],
      ['student', 'mobile'],
    ],
    inTemplate: false,
    textColumn: true,
  },
  {
    key: 'admissionDate',
    label: 'Admission Date',
    description: 'Date of admission. Default: the import date.',
    example: '2025-04-01',
    aliases: ['admission date', 'date of admission', 'doa', 'joining date', 'enrolment date', 'enrollment date'],
    patterns: [
      ['admission', 'date'],
      ['date', 'admission'],
    ],
    dateColumn: true,
  },
  {
    key: 'previousSchool',
    label: 'Previous School',
    description: 'Optional.',
    example: '',
    aliases: ['previous school', 'last school', 'old school', 'school last attended'],
    patterns: [
      ['previous', 'school'],
      ['last', 'school'],
    ],
  },
  {
    key: 'status',
    label: 'Status',
    description: 'Active (or Enrolled), Left, Graduated or Suspended. Default: Active.',
    example: 'Active',
    aliases: ['status', 'student status', 'enrolment status', 'enrollment status'],
    patterns: [['status']],
    options: ['Active', 'Left', 'Graduated', 'Suspended'],
  },
];

const PARENT_FIELDS: FieldDef[] = [
  {
    key: 'name',
    label: 'Parent Name',
    required: true,
    description: 'Full name of the parent or guardian.',
    example: 'Ahmed Khan',
    aliases: ['parent name', 'name', 'father name', 'guardian name', 'full name', 'father', 'guardian', 'parent'],
    patterns: [
      ['father', 'name'],
      ['parent', 'name'],
      ['guardian', 'name'],
    ],
  },
  {
    key: 'phone',
    label: 'Phone',
    required: true,
    description: 'Mobile number, e.g. 03001234567. Used to recognise parents already in the system.',
    example: '03001234567',
    aliases: [
      'phone',
      'mobile',
      'contact',
      'contact no',
      'phone no',
      'mobile no',
      'mobile number',
      'phone number',
      'cell',
      'parent phone',
      'father mobile',
      'guardian phone',
    ],
    patterns: [['phone'], ['mobile'], ['contact'], ['cell']],
    textColumn: true,
  },
  {
    key: 'relation',
    label: 'Relation',
    description: 'Father, Mother, Guardian or Other.',
    example: 'Father',
    aliases: ['relation', 'relationship'],
    patterns: [['relation']],
    options: ['Father', 'Mother', 'Guardian', 'Other'],
  },
  {
    key: 'cnic',
    label: 'CNIC',
    description: '13 digits, e.g. 35202-1234567-1.',
    example: '35202-1234567-1',
    aliases: ['cnic', 'nic', 'cnic no', 'national id'],
    patterns: [['cnic']],
    textColumn: true,
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Optional.',
    example: 'ahmed@example.com',
    aliases: ['email', 'e mail', 'email address'],
    patterns: [['email']],
  },
  {
    key: 'whatsapp',
    label: 'WhatsApp',
    description: 'WhatsApp number if different from Phone.',
    example: '',
    aliases: ['whatsapp', 'whatsapp no', 'whatsapp number'],
    patterns: [['whatsapp']],
    textColumn: true,
  },
  {
    key: 'occupation',
    label: 'Occupation',
    description: 'Optional.',
    example: 'Engineer',
    aliases: ['occupation', 'profession', 'job'],
    patterns: [['occupation'], ['profession']],
  },
  {
    key: 'address',
    label: 'Address',
    description: 'Optional.',
    example: 'House 12, Street 4, Lahore',
    aliases: ['address', 'home address'],
    patterns: [['address']],
  },
  {
    key: 'childAdmissionNos',
    label: 'Children Admission Nos',
    description:
      'Admission numbers of this parent’s children already in the system, separated by commas. Links them to this parent.',
    example: 'ST-1001, ST-1002',
    aliases: [
      'children',
      'child admission no',
      'children admission nos',
      'student admission no',
      'admission no',
      'admission nos',
      'child id',
      'student id',
    ],
    patterns: [['admission'], ['child'], ['children']],
    textColumn: true,
  },
];

const STAFF_FIELDS: FieldDef[] = [
  {
    key: 'employeeNo',
    label: 'Employee No',
    description: 'Staff number. Leave empty to have one generated. Used to recognise staff already in the system.',
    example: 'EMP-0101',
    aliases: ['employee no', 'employee number', 'emp no', 'employee id', 'staff id', 'staff no', 'emp id', 'id'],
    patterns: [['employee', 'no'], ['employee', 'id'], ['staff', 'id'], ['staff', 'no'], ['emp']],
    textColumn: true,
  },
  {
    key: 'fullName',
    label: 'Full Name',
    required: true,
    description: 'Full name. (Instead, you can map separate First name and Last name columns.)',
    example: 'Ayesha Malik',
    aliases: ['name', 'full name', 'employee name', 'staff name', 'teacher name'],
    patterns: [
      ['employee', 'name'],
      ['staff', 'name'],
      ['teacher', 'name'],
    ],
  },
  {
    key: 'firstName',
    label: 'First name',
    description: 'First name (use with Last name).',
    example: 'Ayesha',
    aliases: ['first name', 'given name'],
    patterns: [['first', 'name']],
    inTemplate: false,
  },
  {
    key: 'lastName',
    label: 'Last name',
    description: 'Last name.',
    example: 'Malik',
    aliases: ['last name', 'surname', 'family name'],
    patterns: [['last', 'name'], ['surname']],
    inTemplate: false,
  },
  {
    key: 'staffType',
    label: 'Staff Type',
    required: true,
    description: 'Teaching or Non-teaching. Teaching staff get a teacher login (activation link, nothing is sent).',
    example: 'Teaching',
    aliases: ['staff type', 'type', 'category', 'employee type'],
    patterns: [['staff', 'type'], ['employee', 'type'], ['category']],
    options: ['Teaching', 'Non-teaching'],
  },
  {
    key: 'designation',
    label: 'Designation',
    required: true,
    description: 'Job title, e.g. Teacher, Accountant.',
    example: 'Teacher',
    aliases: ['designation', 'job title', 'title', 'position', 'post', 'role'],
    patterns: [['designation'], ['position'], ['job']],
  },
  {
    key: 'department',
    label: 'Department',
    description: 'Optional.',
    example: 'Science',
    aliases: ['department', 'dept'],
    patterns: [['department'], ['dept']],
  },
  {
    key: 'gender',
    label: 'Gender',
    description: 'Male, Female or Other.',
    example: 'Female',
    aliases: ['gender', 'sex'],
    patterns: [['gender']],
    options: ['Male', 'Female', 'Other'],
  },
  {
    key: 'phone',
    label: 'Phone',
    description: 'Mobile number, e.g. 03001234567.',
    example: '03001234567',
    aliases: ['phone', 'mobile', 'contact', 'contact no', 'phone no', 'mobile no', 'cell'],
    patterns: [['phone'], ['mobile'], ['contact'], ['cell']],
    textColumn: true,
  },
  {
    key: 'email',
    label: 'Email',
    description: 'Used as the login for teachers when given.',
    example: 'ayesha@example.com',
    aliases: ['email', 'e mail', 'email address'],
    patterns: [['email']],
  },
  {
    key: 'cnic',
    label: 'CNIC',
    description: '13 digits (kept private).',
    example: '35202-7654321-2',
    aliases: ['cnic', 'nic', 'cnic no'],
    patterns: [['cnic']],
    textColumn: true,
  },
  {
    key: 'qualification',
    label: 'Qualification',
    description: 'Optional.',
    example: 'M.Sc Physics',
    aliases: ['qualification', 'education', 'degree'],
    patterns: [['qualification'], ['degree']],
  },
  {
    key: 'joiningDate',
    label: 'Joining Date',
    description: 'YYYY-MM-DD.',
    example: '2023-08-01',
    aliases: ['joining date', 'date of joining', 'doj', 'join date', 'hire date'],
    patterns: [['joining'], ['join', 'date'], ['hire']],
    dateColumn: true,
  },
  {
    key: 'basicSalary',
    label: 'Basic Salary',
    description: 'Monthly basic salary in rupees (kept private).',
    example: '45000',
    aliases: ['basic salary', 'salary', 'basic pay', 'pay'],
    patterns: [['salary'], ['basic', 'pay']],
  },
  {
    key: 'address',
    label: 'Address',
    description: 'Optional.',
    example: '',
    aliases: ['address', 'home address'],
    patterns: [['address']],
  },
  {
    key: 'campusName',
    label: 'Campus',
    description: 'Only for schools with more than one campus.',
    example: '',
    aliases: ['campus', 'branch'],
    patterns: [['campus'], ['branch']],
  },
  {
    key: 'status',
    label: 'Status',
    description: 'Active, On leave, Resigned or Terminated. Default: Active.',
    example: 'Active',
    aliases: ['status', 'employment status'],
    patterns: [['status']],
    options: ['Active', 'On leave', 'Resigned', 'Terminated'],
  },
];

const CLASS_FIELDS: FieldDef[] = [
  {
    key: 'className',
    label: 'Class',
    required: true,
    description: 'Class name, e.g. Class 5, PG, Nursery.',
    example: 'Class 5',
    aliases: ['class', 'class name', 'grade', 'standard'],
    patterns: [['class'], ['grade']],
  },
  {
    key: 'level',
    label: 'Level',
    description:
      'Order of the class: Playgroup -2, Nursery -1, Prep/KG 0, Class 1–12 = 1–12. Worked out from the name when empty.',
    example: '5',
    aliases: ['level', 'order', 'class level', 'grade level'],
    patterns: [['level']],
  },
  {
    key: 'sectionName',
    label: 'Section',
    required: true,
    description: 'Section name, e.g. A. One row per section.',
    example: 'A',
    aliases: ['section', 'section name', 'group'],
    patterns: [['section']],
  },
  {
    key: 'capacity',
    label: 'Capacity',
    description: 'Maximum students in the section (1–200). Optional.',
    example: '35',
    aliases: ['capacity', 'seats', 'max students', 'strength'],
    patterns: [['capacity'], ['seats']],
  },
  {
    key: 'room',
    label: 'Room',
    description: 'Optional.',
    example: 'Room 12',
    aliases: ['room', 'room no', 'classroom'],
    patterns: [['room']],
  },
  {
    key: 'sessionName',
    label: 'Session',
    description: 'Academic session, e.g. 2025-2026. Leave empty for the current session.',
    example: '2025-2026',
    aliases: ['session', 'academic year'],
    patterns: [['session']],
    textColumn: true,
  },
  {
    key: 'campusName',
    label: 'Campus',
    description: 'Only for schools with more than one campus.',
    example: '',
    aliases: ['campus', 'branch'],
    patterns: [['campus']],
  },
];

/** One row per punch, as fingerprint machines and their PC software export them. */
const TIMETABLE_FIELDS: FieldDef[] = [
  {
    key: 'className',
    label: 'Class',
    required: true,
    description: 'Class name exactly as in the system, e.g. Class 5.',
    example: 'Class 5',
    aliases: ['class', 'class name', 'grade', 'standard'],
    patterns: [['class'], ['grade']],
  },
  {
    key: 'sectionName',
    label: 'Section',
    description: 'Section name, e.g. A. Needed only when the class has more than one section.',
    example: 'A',
    aliases: ['section', 'section name', 'group'],
    patterns: [['section']],
  },
  {
    key: 'day',
    label: 'Day',
    required: true,
    description:
      'One day (Monday, Mon, or 1–7), a range (Mon-Fri), a list (Mon,Wed,Fri) or All for every school day. A week of the same period is one row.',
    example: 'Mon-Fri',
    aliases: ['day', 'days', 'weekday', 'week day'],
    patterns: [['day']],
  },
  {
    key: 'startTime',
    label: 'Starts',
    required: true,
    description: 'Start time: 08:00, 8:00 AM or 13:30. Without AM/PM, 1:00–6:59 is read as afternoon.',
    example: '08:00',
    aliases: ['starts', 'start', 'start time', 'from', 'time from', 'period start'],
    patterns: [['start']],
    textColumn: true,
  },
  {
    key: 'endTime',
    label: 'Ends',
    required: true,
    description: 'End time, after the start time.',
    example: '08:40',
    aliases: ['ends', 'end', 'end time', 'to', 'time to', 'period end'],
    patterns: [['end']],
    textColumn: true,
  },
  {
    key: 'subjectName',
    label: 'Subject',
    required: true,
    description: 'Subject name or code. It must already exist under Subjects.',
    example: 'English',
    aliases: ['subject', 'subject name', 'subject code', 'course'],
    patterns: [['subject']],
  },
  {
    key: 'teacherName',
    label: 'Teacher',
    description: 'Teacher’s name as in Employees. Optional: a period without a teacher can be given one later.',
    example: 'Ayesha Khan',
    aliases: ['teacher', 'teacher name', 'faculty', 'instructor'],
    patterns: [['teacher']],
  },
  {
    key: 'room',
    label: 'Room',
    description: 'Optional.',
    example: 'Room 12',
    aliases: ['room', 'room no', 'classroom'],
    patterns: [['room']],
  },
  {
    key: 'sessionName',
    label: 'Session',
    description: 'Academic session, e.g. 2026-2027. Leave empty for the current session.',
    example: '',
    aliases: ['session', 'academic year'],
    patterns: [['session']],
    textColumn: true,
  },
  {
    key: 'campusName',
    label: 'Campus',
    description: 'Only for schools with more than one campus.',
    example: '',
    aliases: ['campus', 'branch'],
    patterns: [['campus']],
  },
];

const STAFF_PUNCH_FIELDS: FieldDef[] = [
  {
    key: 'deviceUserId',
    label: 'Device user ID',
    required: true,
    description:
      'The number the machine knows the staff member by (enrolment number, AC-No, user ID or PIN). Link it to the staff member once under Staff attendance → Device users; names are never used to match.',
    example: '17',
    aliases: [
      'device user id',
      'user id',
      'userid',
      'ac no',
      'acno',
      'enroll no',
      'enrollno',
      'enrollment no',
      'enrol no',
      'pin',
      'person id',
      'personnel id',
      'staff id',
      'employee id',
      'emp id',
      'emp no',
      'id',
      'no',
    ],
    patterns: [['enroll'], ['user', 'id'], ['ac', 'no']],
    textColumn: true,
  },
  {
    key: 'dateTime',
    label: 'Date and time',
    description:
      'The punch date and time in one column, e.g. 2026-10-24 08:01:33 or 24/10/2026 8:01 AM. Times are the machine’s clock in the school’s time zone unless they say otherwise (…Z or +05:00).',
    example: '2026-10-24 08:01:33',
    aliases: [
      'date time',
      'datetime',
      'date and time',
      'time',
      'punch time',
      'check time',
      'log time',
      'att time',
      'timestamp',
      'record time',
      'clock time',
    ],
    patterns: [
      ['date', 'time'],
      ['punch', 'time'],
      ['check', 'time'],
    ],
  },
  {
    key: 'date',
    label: 'Date (separate column)',
    description: 'When the date and the time are in two columns: the date. Map the time column to Time.',
    example: '2026-10-24',
    aliases: ['date', 'punch date', 'att date', 'attendance date', 'log date'],
    inTemplate: false,
  },
  {
    key: 'time',
    label: 'Time (separate column)',
    description: 'When the date and the time are in two columns: the time of day, e.g. 08:01 or 8:01 AM.',
    example: '08:01',
    aliases: ['punch time only', 'time only', 'clock in time'],
    inTemplate: false,
  },
  {
    key: 'punchType',
    label: 'Punch type',
    description:
      'Optional: In/Out, Check In/Check Out, C/In, C/Out. Other values (numeric state codes, whose meaning differs between machines) are kept but not read as arrival or departure.',
    example: 'Check In',
    aliases: [
      'punch type',
      'type',
      'state',
      'status',
      'check type',
      'in out',
      'in/out',
      'io',
      'direction',
      'attendance state',
      'verify state',
    ],
    options: ['Check In', 'Check Out'],
  },
  {
    key: 'name',
    label: 'Name (shown only)',
    description:
      'Optional: shown in the preview to help you check the file. It is never used to decide who the punch belongs to.',
    example: 'Ayesha Khan',
    aliases: ['name', 'user name', 'employee name', 'staff name', 'person name'],
  },
];

const FEE_FIELDS: FieldDef[] = [
  {
    key: 'admissionNo',
    label: 'Admission No',
    description:
      'The student’s admission number in School OS. The surest way to find the student; without it the student is found by name and class (plus father’s name or phone when two students share a name).',
    example: 'ST-1001',
    aliases: [
      'admission no',
      'admission number',
      'adm no',
      'registration no',
      'reg no',
      'gr no',
      'student id',
      'roll no',
    ],
    patterns: [['admission'], ['registration'], ['gr', 'no']],
    textColumn: true,
  },
  {
    key: 'studentName',
    label: 'Student Name',
    required: true,
    description: 'As in School OS. Spelling, capitals, dots and spaces do not matter ("M. Ali" = "Muhammad Ali").',
    example: 'Ali Ahmed',
    aliases: ['student name', 'name', 'student', 'full name', 'name of student', 'student s name'],
    patterns: [['student', 'name'], ['student']],
  },
  {
    key: 'fatherName',
    label: 'Father Name',
    description: 'Tells apart students with the same name in a class. Not changed in School OS.',
    example: 'Ahmed Khan',
    aliases: ['father name', 'father', 'fathers name', 'parent name', 'guardian name', 'f name'],
    patterns: [['father'], ['guardian'], ['parent', 'name']],
  },
  {
    key: 'className',
    label: 'Class',
    required: true,
    description: 'The student’s class in School OS, e.g. Class 5. Checked against the student’s current class.',
    example: 'Class 5',
    aliases: ['class', 'class name', 'grade'],
    patterns: [['class'], ['grade']],
  },
  {
    key: 'sectionName',
    label: 'Section',
    description: 'Optional. Narrows the search when a class has several sections.',
    example: 'A',
    aliases: ['section', 'section name'],
    patterns: [['section']],
  },
  {
    key: 'parentPhone',
    label: 'Parent Phone',
    description: 'Optional. Tells apart students with the same name. Not changed in School OS.',
    example: '03001234567',
    aliases: ['phone', 'contact', 'mobile', 'contact no', 'parent phone', 'father phone', 'cell'],
    patterns: [['phone'], ['contact'], ['mobile'], ['cell']],
    textColumn: true,
  },
  {
    key: 'monthlyFee',
    label: 'Monthly Fee',
    description:
      'What this student pays every month, in whole rupees. It replaces the class fee for this student from the next invoices on. Leave empty to keep the class fee.',
    example: '2500',
    aliases: ['monthly fee', 'fee', 'tuition fee', 'monthly tuition', 'tuition', 'fee per month', 'current fee'],
    patterns: [['monthly', 'fee'], ['tuition'], ['fee']],
  },
  {
    key: 'arrears',
    label: 'Previous Dues',
    description:
      'Everything the student still owes from before (all old months together), in whole rupees. Added once as "Previous dues"; it then appears on the next fee voucher. Leave empty or 0 when nothing is due.',
    example: '6000',
    // "Outstanding"/"Balance" (owed after payments) beat "Arrears" (often owed before this
    // month's payment) when a statement has both, so Arrears is only a keyword match.
    aliases: [
      'previous dues',
      'outstanding',
      'balance',
      'dues',
      'remaining',
      'opening balance',
      'previous balance',
      'balance due',
      'total outstanding',
    ],
    patterns: [
      ['previous', 'dues'],
      ['outstanding'],
      ['opening', 'balance'],
      ['balance'],
      ['dues'],
      ['arrears'],
      ['arrear'],
    ],
  },
  {
    key: 'notes',
    label: 'Notes',
    description: 'Optional, kept on the previous dues record (e.g. "includes annual charges").',
    example: '',
    aliases: ['notes', 'note', 'remarks', 'comment'],
    patterns: [['note'], ['remark']],
  },
];

export const TYPE_DEFS: Record<ImportType, TypeDef> = {
  students: {
    type: 'students',
    label: 'Students and parents',
    description: 'Admit students into existing classes and sections, with their parent or guardian.',
    permission: 'students:manage',
    identifier: 'Admission No',
    fields: STUDENT_FIELDS,
    oneOf: [['fullName', 'firstName']],
    knownIgnored: [
      {
        patterns: [['fee'], ['plan']],
        reason: 'Fees come from the class’s fee structure in this system, not from a per-student plan',
      },
      { patterns: [['photo'], ['picture'], ['image']], reason: 'Photos cannot be imported from a spreadsheet' },
    ],
  },
  parents: {
    type: 'parents',
    label: 'Parents and guardians',
    description: 'Add parent records and link them to students already in the system.',
    permission: 'parents:manage',
    identifier: 'Phone',
    fields: PARENT_FIELDS,
  },
  staff: {
    type: 'staff',
    label: 'Teachers and staff',
    description: 'Add teaching and non-teaching staff. Teachers get a login waiting for activation.',
    permission: 'employees:manage',
    identifier: 'Employee No',
    fields: STAFF_FIELDS,
    oneOf: [['fullName', 'firstName']],
  },
  classes: {
    type: 'classes',
    label: 'Classes and sections',
    description: 'Create classes and their sections. Import these before students.',
    permission: 'academics:manage',
    identifier: 'Class + Section + Session',
    fields: CLASS_FIELDS,
  },
  timetable: {
    type: 'timetable',
    label: 'Timetable',
    description:
      'Weekly periods of each class: day, time, subject, teacher and room. Import classes, subjects and teachers first.',
    permission: 'timetable:manage',
    identifier: 'Class + Section + Session + Day + Start and end time',
    fields: TIMETABLE_FIELDS,
    guide: [
      'One row = one class and one period. Put several days in the Day column (Mon-Fri, Mon,Wed,Fri, or All) so a whole week of the same period is a single row.',
      'All means every school day of your school (Settings → School days). A day on which the school is closed is skipped with a warning.',
      'Subjects must already exist under Subjects, and classes with their sections under Academics. A teacher who is not found is left out (warning); the period is still added.',
      'A class cannot have two periods at the same time, and a teacher or a room cannot be in two classes at the same time. Rows that clash are listed with the reason and are not imported.',
      'Uploading again: “Add new records and update existing ones” changes the subject, teacher or room of a period that already exists for the same class, day and time. Imports never delete periods; remove old ones in Timetable.',
      'Breaks, assembly and lunch are not periods: leave them out.',
    ],
    knownIgnored: [
      { patterns: [['break']], reason: 'Breaks and assembly are not periods; leave them out' },
    ],
  },
  staff_punches: {
    type: 'staff_punches',
    label: 'Staff attendance punches',
    description:
      'Fingerprint machine attendance for teachers and staff, from the machine’s export (CSV, Excel or TXT). Register the device first under Staff attendance → Devices.',
    permission: 'employees:manage',
    identifier: 'Device + device user ID + time',
    fields: STAFF_PUNCH_FIELDS,
    oneOf: [['dateTime', 'date']],
    knownIgnored: [
      {
        patterns: [['fingerprint'], ['template'], ['face'], ['photo']],
        reason: 'Biometric data (fingerprints, faces) is never imported or stored',
      },
    ],
  },
  fees: {
    type: 'fees',
    label: 'Student fees and previous dues',
    description:
      'Set each student’s own monthly fee and bring in what they still owe from before. For students already in School OS; import students first.',
    permission: 'fees:manage',
    identifier: 'Admission No, or Student Name + Class',
    fields: FEE_FIELDS,
    oneOf: [['monthlyFee', 'arrears']],
    guide: [
      'One row per student who is already in School OS (import students first). Students are found, never created or renamed.',
      'Fill Monthly Fee, Previous Dues, or both. An empty cell leaves that part unchanged.',
      'Previous Dues = what is still owed today after all payments, all old months together. Do not include the month you will bill next in School OS.',
      'Amounts in whole rupees: 2500, 2,500 and Rs 2500 all work; 3000+600 is added up (3600). A dash (-) means 0.',
      'When importing, you choose the month the dues are up to (e.g. October 2026). Then generate invoices from the next month on: each voucher shows the previous dues and the total payable.',
    ],
    knownIgnored: [
      {
        patterns: [['paid'], ['received']],
        reason: 'Payments are not imported: put what is still owed (after payments) in Previous Dues',
      },
      { patterns: [['total']], reason: 'Not needed: Monthly Fee and Previous Dues are imported separately' },
    ],
  },
};

/** Lower-case words only: "Father's/Guard. Mobile *" → "father guard mobile". */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/['’`]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type MatchSource = 'remembered' | 'exact' | 'likely';
export interface ColumnMapping {
  column: number;
  header: string;
  field: string | null;
  source?: MatchSource;
  /** Why the column is ignored when it looks like known-unsupported data. */
  ignoredReason?: string;
}

/**
 * Suggest a field for each column. Each field is used at most once; when two columns compete,
 * the stronger match wins (remembered > exact > longer keyword pattern > earlier column).
 */
export function suggestMapping(
  type: ImportType,
  headers: string[],
  remembered: Record<string, string> = {},
): ColumnMapping[] {
  const def = TYPE_DEFS[type];
  const fieldKeys = new Set(def.fields.map((f) => f.key));
  type Candidate = { column: number; field: string; score: number; source: MatchSource };
  const candidates: Candidate[] = [];
  headers.forEach((header, column) => {
    const n = normaliseHeader(header);
    if (!n) return;
    const words = new Set(n.split(' '));
    const rem = remembered[n];
    if (rem && (rem === '__ignore' || fieldKeys.has(rem))) {
      candidates.push({ column, field: rem, score: 1000, source: 'remembered' });
      return;
    }
    for (const f of def.fields) {
      if (normaliseHeader(f.label) === n || f.aliases.some((a) => normaliseHeader(a) === n)) {
        candidates.push({ column, field: f.key, score: 500, source: 'exact' });
        continue;
      }
      const best = Math.max(0, ...(f.patterns ?? []).filter((p) => p.every((w) => words.has(w))).map((p) => p.length));
      if (best) candidates.push({ column, field: f.key, score: 10 * best, source: 'likely' });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.column - b.column);
  const usedColumns = new Set<number>();
  const usedFields = new Set<string>();
  const chosen = new Map<number, Candidate>();
  for (const c of candidates) {
    if (usedColumns.has(c.column) || (c.field !== '__ignore' && usedFields.has(c.field))) continue;
    usedColumns.add(c.column);
    if (c.field !== '__ignore') usedFields.add(c.field);
    chosen.set(c.column, c);
  }
  return headers.map((header, column) => {
    const c = chosen.get(column);
    if (c && c.field !== '__ignore') return { column, header, field: c.field, source: c.source };
    // Substring match here: exports often glue words together ("Feeplanlist").
    const flat = normaliseHeader(header).replace(/ /g, '');
    const known = def.knownIgnored?.find((k) => k.patterns.some((p) => p.every((w) => flat.includes(w))));
    return {
      column,
      header,
      field: null,
      ...(c ? { source: c.source } : {}),
      ...(known ? { ignoredReason: known.reason } : {}),
    };
  });
}

/** Required fields not covered by the mapping (or by a default the user chose). */
export function missingRequired(type: ImportType, mapped: Set<string>): string[] {
  const def = TYPE_DEFS[type];
  const missing: string[] = [];
  for (const group of def.oneOf ?? []) if (!group.some((k) => mapped.has(k))) missing.push(group[0]);
  const inGroups = new Set((def.oneOf ?? []).flat());
  for (const f of def.fields) {
    if (!f.required || inGroups.has(f.key) || mapped.has(f.key)) continue;
    // Students: a section can come from the class (when it has only one) or be chosen for all
    // rows, so a missing Section column is checked per row instead.
    if (f.key === 'sectionName' && type === 'students') continue;
    missing.push(f.key);
  }
  return missing;
}

export const fieldLabel = (type: ImportType, key: string) =>
  TYPE_DEFS[type].fields.find((f) => f.key === key)?.label ?? key;
